import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);

const send = (method: string, path: string, body: unknown, who = admin) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
type Drug = { id: string; version: number; name: string; schedule: string; mrpPaise?: number; ceilingPaise?: number; active: boolean };

describe('POST /admin/drugs', () => {
  const post = (body: unknown, who = admin) => send('POST', '/admin/drugs', body, who);

  it('adds an active drug at version 1, found by the staff search, and audits it', async () => {
    const res = await post({ name: ' Zolpidem Test ', strength: '10 mg', form: 'tablet', schedule: 'H1', hsn: '3004', gstRate: 12, mrpPaise: 4000, ceilingPaise: 5000 });
    expect(res.status).toBe(201);
    const drug = (await res.json()) as Drug;
    expect(drug).toMatchObject({ name: 'Zolpidem Test', schedule: 'H1', gstRate: 12, mrpPaise: 4000, ceilingPaise: 5000, active: true, version: 1 });
    const found = (await (await app.request('/staff/drugs?q=zolpidem', {}, admin)).json()) as Drug[];
    expect(found.map((d) => d.id)).toContain(drug.id);
    const { rows } = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'drug' AND record_id = $1", [drug.id]);
    expect(rows).toHaveLength(1);
  });

  it('403 for a Head Doctor; 422 for a bad schedule, MRP above ceiling, a missing name, an unknown field', async () => {
    expect((await post({ name: 'X Drug', schedule: 'OTC' }, head)).status).toBe(403);
    expect((await post({ name: 'X Drug', schedule: 'Z' })).status).toBe(422);
    const over = await post({ name: 'X Drug', schedule: 'OTC', mrpPaise: 600, ceilingPaise: 500 });
    expect(over.status).toBe(422);
    expect(await over.json()).toMatchObject({ error: 'invalid_input' });
    expect((await post({ schedule: 'OTC' })).status).toBe(422);
    expect((await post({ name: 'X Drug', schedule: 'OTC', gstRate: 7 })).status).toBe(422);
    expect((await post({ name: 'X Drug', schedule: 'OTC', active: false })).status).toBe(422);
  });
});

describe('PATCH /admin/drugs/{id}', () => {
  const patch = (id: string, body: unknown, who = admin) => send('PATCH', `/admin/drugs/${id}`, body, who);
  const make = async (extra: object = {}) =>
    (await (await send('POST', '/admin/drugs', { name: 'Patchable', schedule: 'H', mrpPaise: 1000, ceilingPaise: 2000, ...extra })).json()) as Drug;

  it('edits, bumps the version, keeps history with the reason', async () => {
    const drug = await make();
    const res = await patch(drug.id, { version: 1, mrpPaise: 1500, reason: 'New MRP' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mrpPaise: 1500, version: 2, name: 'Patchable' });
    const { rows } = await db.query('SELECT reason FROM drugs_versions WHERE record_id = $1', [drug.id]);
    expect(rows).toEqual([{ reason: 'New MRP' }]);
  });

  it('409 for a stale version, 404 unknown id, 403 non-Admin', async () => {
    const drug = await make();
    expect((await patch(drug.id, { version: 1, form: 'syrup' })).status).toBe(200);
    expect((await patch(drug.id, { version: 1, form: 'tablet' })).status).toBe(409);
    expect((await patch('00000000-0000-4000-8000-000000000000', { version: 1, form: 'x' })).status).toBe(404);
    expect((await patch(drug.id, { version: 2, form: 'x' }, head)).status).toBe(403);
  });

  it('422 for no change, or MRP above the merged ceiling', async () => {
    const drug = await make();
    expect((await patch(drug.id, { version: 1 })).status).toBe(422);
    expect((await patch(drug.id, { version: 1, name: 'Patchable' })).status).toBe(422);
    expect((await patch(drug.id, { version: 1, mrpPaise: 3000 })).status).toBe(422);
    expect((await patch(drug.id, { version: 1, ceilingPaise: 500 })).status).toBe(422);
    expect((await patch(drug.id, { version: 1, schedule: 'bad' })).status).toBe(422);
  });

  it('deactivates: drops out of search, the row is still there', async () => {
    const drug = await make({ name: 'Retiring Drug' });
    const res = await patch(drug.id, { version: 1, active: false, reason: 'Withdrawn' });
    expect(await res.json()).toMatchObject({ active: false, version: 2 });
    const found = (await (await app.request('/staff/drugs?q=retiring', {}, admin)).json()) as Drug[];
    expect(found).toHaveLength(0);
    const { rows } = await db.query('SELECT active FROM drugs WHERE id = $1', [drug.id]);
    expect(rows).toHaveLength(1);
  });
});
