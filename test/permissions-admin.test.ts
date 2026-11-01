import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { PERMISSIONS } from '../src/permissions/catalog.js';
import { fakeStaffAccounts } from './fake-staff-accounts.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db, staffAccounts: fakeStaffAccounts() });

function as(sub: string, groups: string[]) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}
const admin = as('dev-admin', ['admin']);
const head = as('dev-head-doctor', ['head_doctor']);

describe('GET /admin/permissions', () => {
  it('gives the whole catalog with en/hi text and adminOnly, to Admin and Head Doctor', async () => {
    for (const who of [admin, head]) {
      const res = await app.request('/admin/permissions', {}, who);
      expect(res.status).toBe(200);
      const list = (await res.json()) as { key: string; adminOnly: boolean; descriptionHi: string }[];
      expect(list).toHaveLength(PERMISSIONS.length);
      expect(list.find((p) => p.key === 'user.create')).toMatchObject({ adminOnly: true });
      expect(list.find((p) => p.key === 'bill.view')).toMatchObject({ adminOnly: false, descriptionHi: expect.any(String) });
    }
    expect((await app.request('/admin/permissions', {}, as('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

const idOf = async (sub: string) => String((await db.query('SELECT id FROM users WHERE cognito_sub = $1', [sub])).rows[0]?.id);
const put = async (sub: string, body: unknown, who = admin) => {
  const res = await app.request(
    `/admin/users/${await idOf(sub)}/permissions`,
    { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    who,
  );
  return { status: res.status, body: (await res.json()) as { version: number; effective: string[]; error?: string; message?: string } };
};

describe('GET /admin/users/{id}/permissions', () => {
  it('shows where each permission comes from', async () => {
    const res = await app.request(`/admin/users/${await idOf('dev-reception')}/permissions`, {}, head);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: 'dev-reception', type: 'staff', fromBundles: [{ bundle: 'reception' }] });
    expect((await app.request('/admin/users/00000000-0000-4000-8000-000000000000/permissions', {}, admin)).status).toBe(404);
  });
});

describe('PUT /admin/users/{id}/permissions', () => {
  it('saves allow and deny with the version check, and returns the result', async () => {
    const res = await put('dev-nurse', { version: 0, allow: ['bill.view'], deny: ['vitals.record'], reason: 'covers billing desk' });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
    expect(res.body.effective).toContain('bill.view');
    expect(res.body.effective).not.toContain('vitals.record');
    expect((await put('dev-nurse', { version: 0, allow: [], deny: [], reason: 'stale edit' })).status).toBe(409);
  });

  it('422 for unknown permissions, both lists, a missing reason', async () => {
    expect((await put('dev-nurse', { version: 1, allow: ['bill.everything'], deny: [], reason: 'xxxxx' })).status).toBe(422);
    expect((await put('dev-nurse', { version: 1, allow: ['bill.view'], deny: ['bill.view'], reason: 'xxxxx' })).status).toBe(422);
    expect((await put('dev-nurse', { version: 1, allow: [], deny: [] })).status).toBe(422);
  });

  it('nobody changes their own; a Head Doctor can not touch an Admin or give Admin-only permissions', async () => {
    expect(await put('dev-head-doctor', { version: 0, allow: ['bill.view'], deny: [], reason: 'for myself' }, head)).toMatchObject({
      status: 403,
      body: { message: 'nobody changes their own permissions' },
    });
    expect((await put('dev-admin', { version: 0, allow: [], deny: ['bill.view'], reason: 'head on admin' }, head)).status).toBe(403);
    expect(await put('dev-doctor', { version: 0, allow: ['user.create'], deny: [], reason: 'give admin-only' }, head)).toMatchObject({
      status: 403,
      body: { message: 'only an Admin gives: user.create' },
    });
    expect((await put('dev-doctor', { version: 0, allow: ['bill.view'], deny: [], reason: 'billing too' }, head)).status).toBe(200);
  });

  it('409 last_admin when the only Admin would lose a user.* permission', async () => {
    const second = as('admin-2', ['admin']);
    expect(await put('dev-admin', { version: 0, allow: [], deny: ['user.create'], reason: 'test last admin' }, second)).toMatchObject({
      status: 409,
      body: { error: 'last_admin' },
    });
    // With a second active Admin, the first may lose it.
    await db.query(
      `INSERT INTO users (id, status, created_by, updated_by, cognito_sub, name, email, mobile, type, department_ids, active)
       VALUES (gen_random_uuid(), 'active', 'x', 'x', 'admin-2', 'Second Admin', 'admin2@x.in', '9000000002', 'admin', '[]', true)`,
    );
    expect((await put('dev-admin', { version: 0, allow: [], deny: ['user.create'], reason: 'two admins now' }, second)).status).toBe(200);
  });
});

describe('GET /admin/type-permissions', () => {
  it('lists every staff type with its permissions and built-in list', async () => {
    const res = await app.request('/admin/type-permissions', {}, head);
    expect(res.status).toBe(200);
    const list = (await res.json()) as { type: string; version: number; permissions: string[]; defaults: string[] }[];
    expect(list.map((t) => t.type)).toEqual(['admin', 'head_doctor', 'doctor', 'nurse', 'staff', 'medical', 'insurance', 'gp']);
    expect(list.find((t) => t.type === 'nurse')).toMatchObject({ version: 1, permissions: expect.arrayContaining(['vitals.record']) });
    expect((await app.request('/admin/type-permissions', {}, as('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('PUT /admin/type-permissions/{type}', () => {
  const putType = async (type: string, body: unknown, who = admin) => {
    const res = await app.request(
      `/admin/type-permissions/${type}`,
      { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
      who,
    );
    return { status: res.status, body: (await res.json()) as { version: number; permissions: string[]; error?: string; message?: string } };
  };

  it('changes the list for every user of the type, with the version check', async () => {
    const res = await putType('gp', { version: 1, permissions: ['patient.view', 'patient.view'], reason: 'gps see patients' });
    expect(res).toMatchObject({ status: 200, body: { version: 2, permissions: ['patient.view'] } });
    const perms = await app.request(`/admin/users/${await idOf('dev-gp')}/permissions`, {}, admin);
    expect(await perms.json()).toMatchObject({ fromType: ['patient.view'] });
    expect((await putType('gp', { version: 1, permissions: [], reason: 'stale edit' })).status).toBe(409);
  });

  it('422 for an unknown type or permission, or a grant-only one', async () => {
    expect((await putType('janitor', { version: 1, permissions: [], reason: 'no such type' })).status).toBe(422);
    expect((await putType('nurse', { version: 1, permissions: ['nurse.fly'], reason: 'no such key' })).status).toBe(422);
    expect((await putType('nurse', { version: 1, permissions: ['mtp.view'], reason: 'grant only' })).status).toBe(422);
  });

  it('a Head Doctor can not change the Admin type, their own type, or give Admin-only permissions', async () => {
    expect((await putType('admin', { version: 1, permissions: [], reason: 'head on admin' }, head)).status).toBe(403);
    expect((await putType('head_doctor', { version: 1, permissions: [], reason: 'own type' }, head)).status).toBe(403);
    expect(await putType('nurse', { version: 1, permissions: ['user.create'], reason: 'admin-only' }, head)).toMatchObject({
      status: 403,
      body: { message: 'only an Admin gives: user.create' },
    });
  });

  it('409 last_admin when no active Admin would keep every user.* permission', async () => {
    const res = await putType('admin', { version: 1, permissions: ['user.view'], reason: 'strip admins' });
    expect(res).toMatchObject({ status: 409, body: { error: 'last_admin' } });
  });
});
