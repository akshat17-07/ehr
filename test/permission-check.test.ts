import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import { assertPermission, loadPermissions, requirePermission } from '../src/permissions/check.js';
import { saveCustomPermissions } from '../src/permissions/custom.js';
import { DEFAULT_TYPE_PERMISSIONS } from '../src/permissions/defaults.js';
import { createGrant } from '../src/permissions/grants.js';
import type { AuthEnv, CurrentUser } from '../src/middleware/auth.js';
import { onError } from '../src/middleware/errors.js';

const now = new Date();
const inDays = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

describe('permission check', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
  });
  afterAll(() => db.close());

  // A tiny app with one guarded route per check, as real routes will use them.
  function app(user: CurrentUser) {
    return new Hono<AuthEnv>()
      .use(async (c, next) => {
        c.set('db', async () => db);
        c.set('user', user);
        await next();
      })
      .get('/bills', requirePermission('bill.view'), (c) => c.json({ ok: true }))
      .get('/patients/:id/usg', async (c) => {
        await assertPermission(c, 'pcpndt.view', { patientId: c.req.param('id'), departmentIds: ['d-radiology'] });
        return c.json({ ok: true });
      })
      .onError(onError);
  }
  const staff = (sub: string, groups: string[]): CurrentUser => ({ sub, email: `${sub}@x.in`, pool: 'staff', groups });

  it('uses the type permissions', async () => {
    expect((await app(staff('doc-1', ['doctor'])).request('/bills')).status).toBe(200);
    const res = await app(staff('nurse-1', ['nurse'])).request('/bills');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: 'needs bill.view' });
  });

  it('adds bundles and custom allows, then takes away custom denies', async () => {
    await db.query("INSERT INTO user_permissions (id, status, created_by, updated_by, user_id, allow, deny, bundles) VALUES (gen_random_uuid(), 'active', 'u', 'u', 'staff-1', '[]', '[]', '[\"billing\", \"gone\"]')");
    expect((await app(staff('staff-1', ['staff'])).request('/bills')).status).toBe(200);

    await saveCustomPermissions(db, { userId: 'nurse-2', version: 0, allow: ['bill.view'], deny: [], by: 'admin-1', reason: 'desk' });
    expect((await app(staff('nurse-2', ['nurse'])).request('/bills')).status).toBe(200);

    await saveCustomPermissions(db, { userId: 'doc-2', version: 0, allow: [], deny: ['bill.view'], by: 'admin-1', reason: 'no billing' });
    expect((await app(staff('doc-2', ['doctor'])).request('/bills')).status).toBe(403);
  });

  it('counts grants for "all" everywhere, and patient / department grants only for that target', async () => {
    const usg = (sub: string, patient: string) => app(staff(sub, ['doctor'])).request(`/patients/${patient}/usg`);
    expect((await usg('doc-3', 'p-1')).status).toBe(403); // grant only

    await createGrant(db, { userId: 'doc-3', permission: 'pcpndt.view', scope: 'patient', scopeId: 'p-1', end: inDays(1), grantorId: 'head-1', reason: 'scan' });
    expect((await usg('doc-3', 'p-1')).status).toBe(200);
    expect((await usg('doc-3', 'p-2')).status).toBe(403);

    await createGrant(db, { userId: 'doc-4', permission: 'pcpndt.view', scope: 'department', scopeId: 'd-radiology', end: inDays(1), grantorId: 'head-1', reason: 'USG duty' });
    expect((await usg('doc-4', 'p-9')).status).toBe(200);

    await createGrant(db, { userId: 'nurse-3', permission: 'bill.view', scope: 'all', end: inDays(1), grantorId: 'head-1', reason: 'cover' });
    expect((await app(staff('nurse-3', ['nurse'])).request('/bills')).status).toBe(200);
    // A scoped grant never opens a whole endpoint.
    await createGrant(db, { userId: 'nurse-4', permission: 'bill.view', scope: 'patient', scopeId: 'p-1', end: inDays(1), grantorId: 'head-1', reason: 'one bill' });
    expect((await app(staff('nurse-4', ['nurse'])).request('/bills')).status).toBe(403);
  });

  it('a custom deny also beats a grant', async () => {
    await saveCustomPermissions(db, { userId: 'doc-5', version: 0, allow: [], deny: ['pcpndt.view'], by: 'admin-1', reason: 'not trained' });
    await createGrant(db, { userId: 'doc-5', permission: 'pcpndt.view', scope: 'patient', scopeId: 'p-1', end: inDays(1), grantorId: 'head-1', reason: 'x' });
    expect((await app(staff('doc-5', ['doctor'])).request('/patients/p-1/usg')).status).toBe(403);
  });

  it('gives patients and unknown groups nothing', async () => {
    expect((await app({ sub: 'pat-1', email: '', pool: 'patient', groups: ['admin'] }).request('/bills')).status).toBe(403);
    expect((await app(staff('x-1', ['cleaner'])).request('/bills')).status).toBe(403);
  });

  it('loads the permissions once per request', async () => {
    let reads = 0;
    const counting = { query: (sql: string, params?: unknown[]) => (reads++, db.query(sql, params)) };
    const res = await new Hono<AuthEnv>()
      .use(async (c, next) => {
        c.set('db', async () => counting);
        c.set('user', staff('doc-6', ['doctor']));
        await next();
      })
      .get('/twice', requirePermission('patient.view'), requirePermission('patient.search'), (c) => c.json('ok'))
      .request('/twice');
    expect(res.status).toBe(200);
    expect(reads).toBe(3); // type, custom, grants: once each (no bundles to read)
  });

  it('explains where each permission comes from (#306)', async () => {
    const perms = await loadPermissions(db, 'staff-1', ['staff']);
    expect(perms.type).toBe('staff');
    expect(perms.fromType).toEqual([...DEFAULT_TYPE_PERMISSIONS.staff].sort());
    expect(perms.fromBundles.map((b) => b.bundle)).toEqual(['billing']); // unknown bundle "gone" left out
    expect(perms.effective).toContain('bill.view');
    expect(perms.version).toBe(1);
  });
});
