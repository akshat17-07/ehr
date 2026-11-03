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
const doctor = asStaff('dev-doctor', ['doctor']);

const send = (method: string, path: string, body: unknown, who = admin) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

describe('POST /admin/departments', () => {
  const post = (body: unknown, who = admin) => send('POST', '/admin/departments', body, who);

  it('adds a department; staff see it in the list, and the write is audited', async () => {
    const res = await post({ code: 'pae', nameEn: 'Paediatrics', nameHi: 'बाल रोग' });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { id: string };
    expect(made).toMatchObject({ code: 'PAE', nameEn: 'Paediatrics', nameHi: 'बाल रोग', active: true, version: 1 });

    const list = (await (await app.request('/staff/departments', {}, asStaff('dev-nurse', ['nurse']))).json()) as { id: string }[];
    expect(list.map((d) => d.id)).toContain(made.id);

    const { rows } = await db.query("SELECT record_type, record_id FROM audit_events WHERE record_type = 'department' AND record_id = $1", [made.id]);
    expect(rows).toHaveLength(1);
  });

  it('409 duplicate for a code in use, even an inactive one', async () => {
    const res = await post({ code: 'MED', nameEn: 'Another', nameHi: 'दूसरा' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'duplicate', departmentId: expect.any(String) });
    await db.query("UPDATE departments SET active = false WHERE code = 'DEN'");
    expect((await post({ code: 'DEN', nameEn: 'Dental 2', nameHi: 'दंत' })).status).toBe(409);
  });

  it('422 for a bad code, a missing or blank name, or an unknown field', async () => {
    expect((await post({ code: '1AB', nameEn: 'X', nameHi: 'x' })).status).toBe(422);
    expect((await post({ code: 'A', nameEn: 'X', nameHi: 'x' })).status).toBe(422);
    expect((await post({ code: 'XYZ', nameEn: '  ', nameHi: 'x' })).status).toBe(422);
    expect((await post({ code: 'XYZ', nameEn: 'X' })).status).toBe(422);
    expect((await post({ code: 'XYZ', nameEn: 'X', nameHi: 'x', active: false })).status).toBe(422);
    expect((await send('POST', '/admin/departments', undefined)).status).toBe(422);
  });

  it('403 for a Head Doctor (Admin only) and for a doctor', async () => {
    expect((await post({ code: 'ENT', nameEn: 'ENT', nameHi: 'कान' }, head)).status).toBe(403);
    expect((await post({ code: 'ENT', nameEn: 'ENT', nameHi: 'कान' }, doctor)).status).toBe(403);
  });
});
