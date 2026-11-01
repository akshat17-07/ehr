import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { saveCustomPermissions } from '../src/permissions/custom.js';
import { DEFAULT_TYPE_PERMISSIONS } from '../src/permissions/defaults.js';
import { createGrant, revokeGrant } from '../src/permissions/grants.js';

const db = await openLocalDb();
const app = createApp({ db: async () => db });
const inDays = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

function get(sub: string, groups: string[]) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]` };
  return app.request('/staff/me/permissions', {}, { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never);
}

describe('GET /staff/me/permissions', () => {
  it('lists the type permissions for "all"', async () => {
    const res = await get('nurse-1', ['nurse']);
    expect(res.status).toBe(200);
    const { permissions } = (await res.json()) as { permissions: { permission: string; scope: string; source: string }[] };
    expect(permissions.map((p) => p.permission)).toEqual([...DEFAULT_TYPE_PERMISSIONS.nurse].sort());
    expect(permissions.every((p) => p.scope === 'all' && p.source === 'built_in')).toBe(true);
  });

  it('marks bundle permissions, adds custom allows and grants, and leaves out denies', async () => {
    await db.query(
      `INSERT INTO user_permissions (id, status, created_by, updated_by, user_id, allow, deny, bundles)
       VALUES (gen_random_uuid(), 'active', 'a', 'a', 'staff-1', '["stock.count"]', '["bill.void"]', '["billing"]')`,
    );
    await createGrant(db, { userId: 'staff-1', permission: 'pcpndt.view', scope: 'patient', scopeId: 'p-1', end: inDays(2), grantorId: 'head-1', reason: 'scan' });
    const old = await createGrant(db, { userId: 'staff-1', permission: 'mtp.view', scope: 'all', end: inDays(2), grantorId: 'head-1', reason: 'x' });
    await revokeGrant(db, { id: old.id, version: old.version, by: 'head-1', reason: 'done' });

    const { permissions } = (await (await get('staff-1', ['staff'])).json()) as { permissions: Record<string, unknown>[] };
    expect(permissions).toContainEqual({ permission: 'bill.view', scope: 'all', source: 'bundle' });
    expect(permissions).toContainEqual({ permission: 'stock.count', scope: 'all', source: 'built_in' });
    expect(permissions.find((p) => p.permission === 'bill.void')).toBeUndefined();
    expect(permissions.filter((p) => p.source === 'grant')).toEqual([
      { permission: 'pcpndt.view', scope: 'patient', scopeId: 'p-1', until: expect.any(String), source: 'grant' },
    ]);
  });

  it('a permission the type already gives is listed once', async () => {
    await saveCustomPermissions(db, { userId: 'doc-1', version: 0, allow: ['bill.view'], deny: [], by: 'a', reason: 'x' });
    const { permissions } = (await (await get('doc-1', ['doctor'])).json()) as { permissions: { permission: string }[] };
    expect(permissions.filter((p) => p.permission === 'bill.view')).toHaveLength(1);
  });

  it('is only for hospital staff', async () => {
    expect((await get('ins-1', ['insurance'])).status).toBe(403);
    expect((await app.request('/staff/me/permissions')).status).toBe(401);
  });
});
