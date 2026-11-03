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

const post = (body: unknown, who = admin) =>
  app.request('/admin/partner-hospitals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

describe('POST /admin/partner-hospitals', () => {
  it('adds a hospital (name trimmed), lists it, and audits it', async () => {
    const res = await post({ name: '  City Care Hospital  ' });
    expect(res.status).toBe(201);
    const hospital = (await res.json()) as { id: string; version: number; name: string };
    expect(hospital).toMatchObject({ name: 'City Care Hospital', version: 1 });
    const list = (await (await app.request('/staff/partner-hospitals', {}, admin)).json()) as { id: string }[];
    expect(list.map((h) => h.id)).toContain(hospital.id);
    const { rows } = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'partner_hospital' AND record_id = $1", [hospital.id]);
    expect(rows).toHaveLength(1);
  });

  it('403 for a Head Doctor', async () => {
    expect((await post({ name: 'Nope Hospital' }, head)).status).toBe(403);
  });

  it('422 for a missing, blank, too long name or an unknown field', async () => {
    expect((await post({})).status).toBe(422);
    expect((await post({ name: '   ' })).status).toBe(422);
    expect((await post({ name: 'x'.repeat(201) })).status).toBe(422);
    expect((await post({ name: 'Extra Hospital', active: true })).status).toBe(422);
  });

  it('409 duplicate for a name already taken', async () => {
    expect((await post({ name: 'Twin Hospital' })).status).toBe(201);
    const dup = await post({ name: ' Twin Hospital ' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'duplicate' });
  });
});
