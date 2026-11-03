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
const post = (body: unknown, who = admin) => send('POST', '/admin/tpas', body, who);
const patch = (id: string, body: unknown, who = admin) => send('PATCH', `/admin/tpas/${id}`, body, who);
type Tpa = { id: string; version: number; name: string; code?: string; active: boolean };
const make = async (name: string, code?: string) => (await (await post({ name, code })).json()) as Tpa;

describe('POST /admin/tpas', () => {
  it('adds an active TPA at version 1, lists it, and audits it', async () => {
    const res = await post({ name: '  Test TPA ', code: ' TT ' });
    expect(res.status).toBe(201);
    const tpa = (await res.json()) as Tpa;
    expect(tpa).toMatchObject({ name: 'Test TPA', code: 'TT', active: true, version: 1 });
    const list = (await (await app.request('/staff/tpas', {}, admin)).json()) as Tpa[];
    expect(list.find((t) => t.id === tpa.id)).toMatchObject({ name: 'Test TPA' });
    const { rows } = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'tpa' AND record_id = $1", [tpa.id]);
    expect(rows).toHaveLength(1);
  });

  it('403, 422 and 409 duplicate', async () => {
    expect((await post({ name: 'Nope TPA' }, head)).status).toBe(403);
    expect((await post({})).status).toBe(422);
    expect((await post({ name: 'Extra TPA', active: false })).status).toBe(422);
    expect((await post({ name: 'Twin TPA' })).status).toBe(201);
    const dup = await post({ name: 'Twin TPA' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'duplicate' });
  });
});

describe('PATCH /admin/tpas/:id', () => {
  it('edits with history and audit, and null clears the code', async () => {
    const t = await make('Patch Old TPA', 'OLD');
    const res = await patch(t.id, { version: 1, name: 'Patch New TPA', reason: 'rename' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Patch New TPA', code: 'OLD', version: 2 });
    const hist = await db.query('SELECT reason FROM tpas_versions WHERE record_id = $1', [t.id]);
    expect(hist.rows[0]!.reason).toBe('rename');
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'tpa' AND record_id = $1", [t.id]);
    expect(audit.rows).toHaveLength(2);
    const cleared = (await (await patch(t.id, { version: 2, code: null, active: false })).json()) as Tpa;
    expect(cleared.code).toBeUndefined();
    expect(cleared).toMatchObject({ active: false, version: 3 });
  });

  it('403, 404, 409 conflict and duplicate, 422', async () => {
    const t = await make('Err TPA');
    await make('Taken TPA');
    expect((await patch(t.id, { version: 1, name: 'X' }, head)).status).toBe(403);
    expect((await patch('00000000-0000-4000-8000-000000000000', { version: 1, name: 'X' })).status).toBe(404);
    expect((await patch(t.id, { version: 1, name: 'Err TPA 2' })).status).toBe(200);
    expect(await (await patch(t.id, { version: 1, name: 'Err TPA 3' })).json()).toMatchObject({ error: 'conflict' });
    expect(await (await patch(t.id, { version: 2, name: 'Taken TPA' })).json()).toMatchObject({ error: 'duplicate' });
    expect((await patch(t.id, { version: 2, name: 'Err TPA 2' })).status).toBe(422);
    expect((await patch(t.id, { version: 2, extra: 1 })).status).toBe(422);
  });
});
