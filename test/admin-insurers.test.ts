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
  app.request('/admin/insurers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
type Insurer = { id: string; version: number; name: string; code?: string; active: boolean };

describe('POST /admin/insurers', () => {
  it('adds an active insurer at version 1, lists it, and audits it', async () => {
    const res = await post({ name: '  Star Test Insurance ', code: ' STAR ' });
    expect(res.status).toBe(201);
    const insurer = (await res.json()) as Insurer;
    expect(insurer).toMatchObject({ name: 'Star Test Insurance', code: 'STAR', active: true, version: 1 });
    const list = (await (await app.request('/staff/insurers', {}, admin)).json()) as Insurer[];
    expect(list.find((i) => i.id === insurer.id)).toMatchObject({ name: 'Star Test Insurance', active: true });
    const { rows } = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'insurer' AND record_id = $1", [insurer.id]);
    expect(rows).toHaveLength(1);
  });

  it('works without a code', async () => {
    const res = await post({ name: 'No Code Insurance' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Insurer).code).toBeUndefined();
  });

  it('403 for a Head Doctor', async () => {
    expect((await post({ name: 'Nope Insurance' }, head)).status).toBe(403);
  });

  it('422 for a missing, blank or too long name, a blank or long code, or an unknown field', async () => {
    expect((await post({})).status).toBe(422);
    expect((await post({ name: '   ' })).status).toBe(422);
    expect((await post({ name: 'x'.repeat(201) })).status).toBe(422);
    expect((await post({ name: 'Bad Code Insurance', code: '  ' })).status).toBe(422);
    expect((await post({ name: 'Bad Code Insurance', code: 'c'.repeat(51) })).status).toBe(422);
    expect((await post({ name: 'Extra Insurance', active: false })).status).toBe(422);
  });

  it('409 duplicate for a name already taken', async () => {
    expect((await post({ name: 'Twin Insurance' })).status).toBe(201);
    const dup = await post({ name: ' Twin Insurance ' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'duplicate' });
  });
});

const patch = (id: string, body: unknown, who = admin) =>
  app.request(`/admin/insurers/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
const make = async (name: string, code?: string) => (await (await post({ name, code })).json()) as Insurer;

describe('PATCH /admin/insurers/:id', () => {
  it('edits, bumps the version, keeps history with the reason, audits, and null clears the code', async () => {
    const i = await make('Patch Old Insurer', 'OLD');
    const res = await patch(i.id, { version: 1, name: ' Patch New Insurer ', code: 'NEW', reason: 'rebrand' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: i.id, name: 'Patch New Insurer', code: 'NEW', version: 2, active: true });
    const hist = await db.query('SELECT reason FROM insurers_versions WHERE record_id = $1', [i.id]);
    expect(hist.rows[0]!.reason).toBe('rebrand');
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'insurer' AND record_id = $1", [i.id]);
    expect(audit.rows).toHaveLength(2);
    const cleared = (await (await patch(i.id, { version: 2, code: null, active: false })).json()) as Insurer;
    expect(cleared.code).toBeUndefined();
    expect(cleared).toMatchObject({ active: false, version: 3 });
  });

  it('403, 404, 409 conflict and duplicate, 422', async () => {
    const i = await make('Err Insurer');
    await make('Taken Insurer');
    expect((await patch(i.id, { version: 1, name: 'X' }, head)).status).toBe(403);
    expect((await patch('00000000-0000-4000-8000-000000000000', { version: 1, name: 'X' })).status).toBe(404);
    expect((await patch('nope', { version: 1, name: 'X' })).status).toBe(404);
    expect((await patch(i.id, { version: 1, name: 'Err Insurer 2' })).status).toBe(200);
    const stale = await patch(i.id, { version: 1, name: 'Err Insurer 3' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'conflict' });
    const dup = await patch(i.id, { version: 2, name: 'Taken Insurer' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'duplicate' });
    expect((await patch(i.id, { version: 2, name: 'Err Insurer 2', active: true })).status).toBe(422);
    expect((await patch(i.id, { name: 'X' })).status).toBe(422);
    expect((await patch(i.id, { version: 2, name: 'X', reason: 'ab' })).status).toBe(422);
    expect((await patch(i.id, { version: 2, extra: 1 })).status).toBe(422);
  });
});
