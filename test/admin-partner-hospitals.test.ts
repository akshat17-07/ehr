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

type Hospital = { id: string; version: number; name: string; active: boolean };
describe('PATCH /admin/partner-hospitals/{id}', () => {
  const patch = (id: string, body: unknown, who = admin) =>
    app.request(`/admin/partner-hospitals/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const make = async (name: string) => (await (await post({ name })).json()) as Hospital;
  const listed = async () => (await (await app.request('/staff/partner-hospitals', {}, admin)).json()) as Hospital[];

  it('renames, bumps the version, keeps history with the reason, and audits', async () => {
    const h = await make('Patch Old Name');
    expect(h.active).toBe(true);
    const res = await patch(h.id, { version: 1, name: ' Patch New Name ', reason: 'spelling fix' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: h.id, name: 'Patch New Name', version: 2, active: true });
    const hist = await db.query('SELECT reason FROM partner_hospitals_versions WHERE record_id = $1', [h.id]);
    expect(hist.rows).toHaveLength(1);
    expect(hist.rows[0]!.reason).toBe('spelling fix');
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'partner_hospital' AND record_id = $1", [h.id]);
    expect(audit.rows).toHaveLength(2);
  });

  it('deactivates and shows active false in the staff list; null active counts as active', async () => {
    const h = await make('Deactivate Me');
    await db.query('UPDATE partner_hospitals SET active = NULL WHERE id = $1', [h.id]);
    expect((await listed()).find((x) => x.id === h.id)?.active).toBe(true);
    expect((await patch(h.id, { version: 1, active: false })).status).toBe(200);
    expect((await listed()).find((x) => x.id === h.id)).toMatchObject({ active: false });
  });

  it('403 for a Head Doctor', async () => {
    const h = await make('Head Cannot');
    expect((await patch(h.id, { version: 1, name: 'Other' }, head)).status).toBe(403);
  });

  it('404 for an unknown or malformed id', async () => {
    expect((await patch('00000000-0000-4000-8000-000000000000', { version: 1, name: 'X' })).status).toBe(404);
    expect((await patch('nope', { version: 1, name: 'X' })).status).toBe(404);
  });

  it('409 conflict for a stale version; 409 duplicate for a taken name', async () => {
    const h = await make('Stale One');
    await make('Taken Name');
    expect((await patch(h.id, { version: 1, name: 'Stale Two' })).status).toBe(200);
    const stale = await patch(h.id, { version: 1, name: 'Stale Three' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'conflict' });
    const dup = await patch(h.id, { version: 2, name: 'Taken Name' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'duplicate' });
  });

  it('422 when nothing changes, for a missing version, a short reason or an unknown field', async () => {
    const h = await make('No Change');
    const same = await patch(h.id, { version: 1, name: 'No Change', active: true });
    expect(same.status).toBe(422);
    expect(await same.json()).toMatchObject({ error: 'invalid_input' });
    expect((await patch(h.id, { name: 'X' })).status).toBe(422);
    expect((await patch(h.id, { version: 1, name: 'X', reason: 'ab' })).status).toBe(422);
    expect((await patch(h.id, { version: 1, code: 'X' })).status).toBe(422);
  });
});
