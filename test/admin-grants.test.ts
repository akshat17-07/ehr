import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedId } from '../src/db/table.js';
import { seedDev } from '../src/db/seed-dev.js';
import { randomUUID } from 'node:crypto';
import { createGrant, revokeGrant } from '../src/permissions/grants.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);
const headId = seedId('a0000000', 2);
const doctorId = seedId('a0000000', 3);
const surgeonId = seedId('a0000000', 4);

const now = new Date();
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);
const give = (userId: string, permission: string, end = days(30)) =>
  createGrant(db, { userId, permission, scope: 'all', end, grantorId: 'dev-head-doctor', reason: 'cover for leave' }, days(-10));

const active = await give('dev-doctor', 'pcpndt.view');
const expired = await give('dev-doctor', 'mtp.view', days(-1));
const revoked = await revokeGrant(db, { id: (await give('dev-surgeon', 'pcpndt.view')).id, version: 1, by: 'dev-admin', reason: 'not needed' });

// Rows made in the same instant would tie on created_at: space them a minute apart, in the order made.
for (const [i, id] of [active.id, expired.id, revoked.id].entries()) {
  await db.query('UPDATE grants SET created_at = $1 WHERE id = $2', [new Date(now.getTime() + i * 60_000), id]);
}

type Page = { items: { id: string; userId: string; grantorId: string; status: string }[]; nextCursor?: string };
const list = async (query = '', who = admin) => {
  const res = await app.request(`/admin/grants${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as Page };
};

describe('GET /admin/grants', () => {
  it('lists grants newest first, with users.id for the user and the grantor', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((g) => g.id)).toEqual([revoked.id, expired.id, active.id]);
    expect(body.items[2]).toMatchObject({ userId: doctorId, grantorId: headId, permission: 'pcpndt.view', status: 'active' });
  });

  it('filters by user, permission and status', async () => {
    expect((await list(`?userId=${doctorId}`)).body.items.map((g) => g.id)).toEqual([expired.id, active.id]);
    expect((await list(`?userId=${surgeonId}&status=revoked`)).body.items.map((g) => g.id)).toEqual([revoked.id]);
    expect((await list('?permission=pcpndt.view')).body.items.map((g) => g.id)).toEqual([revoked.id, active.id]);
    expect((await list('?status=active')).body.items.map((g) => g.id)).toEqual([active.id]);
    expect((await list('?status=expired')).body.items.map((g) => g.id)).toEqual([expired.id]);
    expect((await list(`?userId=${seedId('a0000000', 9)}`)).body.items).toEqual([]);
  });

  it('pages with a cursor', async () => {
    const first = await list('?limit=2');
    expect(first.body.items).toHaveLength(2);
    const next = await list(`?limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.items.map((g) => g.id)).toEqual([active.id]);
    expect(next.body.nextCursor).toBeUndefined();
  });

  it('422 for a bad filter; 403 without grant.view', async () => {
    expect((await list('?userId=nope')).status).toBe(422);
    expect((await list('?permission=no.such')).status).toBe(422);
    expect((await list('?status=gone')).status).toBe(422);
    expect((await list('', head)).status).toBe(200);
    expect((await list('', asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

describe('POST /admin/grants', () => {
  const adminId = seedId('a0000000', 1);
  const med = seedId('de000000', 1);
  const post = (body: unknown, who = admin) =>
    app.request('/admin/grants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const inDays = (n: number) => days(n).toISOString();
  const good = { userId: doctorId, permission: 'pcpndt.view', scope: 'all', end: inDays(30), reason: 'USG duty this month' };

  it('an Admin gives any grantable permission; users.id comes back', async () => {
    const res = await post(good);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ userId: doctorId, grantorId: adminId, permission: 'pcpndt.view', scope: 'all', status: 'active', version: 1 });
    const perms = (await (await app.request(`/admin/users/${doctorId}/permissions`, {}, admin)).json()) as { effective: string[] };
    expect(perms.effective).toContain('pcpndt.view');
  });

  it('422 for an unknown user or permission, role.*, a bad scope, or an end in the past', async () => {
    expect((await post({ ...good, userId: randomUUID() })).status).toBe(422);
    expect((await post({ ...good, permission: 'no.such' })).status).toBe(422);
    expect((await post({ ...good, permission: 'role.promote_head_doctor' })).status).toBe(422);
    expect((await post({ ...good, scope: 'department' })).status).toBe(422);
    expect((await post({ ...good, scope: 'department', scopeId: randomUUID() })).status).toBe(422);
    expect((await post({ ...good, scope: 'patient', scopeId: randomUUID() })).status).toBe(422);
    expect((await post({ ...good, end: inDays(-1) })).status).toBe(422);
    expect((await post({ ...good, reason: 'x' })).status).toBe(422);
  });

  it('a Head Doctor gives only within an active rule and only what they hold', async () => {
    const hd = { ...good, permission: 'sensitive.label', scope: 'department', scopeId: med, end: inDays(10) };
    expect((await post(hd, head)).status).toBe(403); // no rule yet
    const rule = await app.request('/admin/grant-rules', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grantorUserId: headId, mayGrant: ['sensitive.label', 'pcpndt.view'], scope: 'department', departmentId: med, maxDays: 14 }),
    }, admin);
    expect(rule.status).toBe(201);
    const res = await post(hd, head);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ userId: doctorId, grantorId: headId, scope: 'department', scopeId: med });
    expect((await post({ ...hd, scope: 'all', scopeId: undefined }, head)).status).toBe(403); // rule is for one department
    expect((await post({ ...hd, end: inDays(20) }, head)).status).toBe(403); // longer than the rule
    expect((await post({ ...hd, permission: 'patient.merge' }, head)).status).toBe(403); // not in the rule
    expect((await post({ ...hd, permission: 'pcpndt.view' }, head)).status).toBe(403); // in the rule, but not held
    expect((await post({ ...hd, userId: adminId }, head)).status).toBe(403); // an Admin
    expect((await post({ ...hd, userId: headId }, head)).status).toBe(403); // themselves
    expect((await post(hd, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

describe('POST /admin/grants/{id}/revoke', () => {
  const revoke = (id: string, who = admin, reason = 'duty is over') =>
    app.request(`/admin/grants/${id}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason }) }, who);

  it('ends a grant now; the reason is kept in its history', async () => {
    const res = await revoke(active.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: active.id, userId: doctorId, status: 'revoked', version: 2 });
    const { rows } = await db.query('SELECT reason FROM grants_versions WHERE record_id = $1', [active.id]);
    expect(rows.map((r) => r.reason)).toContain('duty is over');
    expect((await revoke(active.id)).status).toBe(409);
  });

  it('409 for an ended grant; 404 for none; 422 without a reason', async () => {
    expect((await revoke(expired.id)).status).toBe(409);
    expect((await revoke(randomUUID())).status).toBe(404);
    expect((await revoke('nope')).status).toBe(404);
    expect((await revoke(expired.id, admin, 'x')).status).toBe(422);
  });

  it('a Head Doctor takes back only the grants they gave', async () => {
    const mine = await give('dev-doctor', 'mtp.view');
    const theirs = await createGrant(db, { userId: 'dev-doctor', permission: 'mtp.write', scope: 'all', end: days(5), grantorId: 'dev-admin', reason: 'cover for leave' });
    expect((await revoke(theirs.id, head)).status).toBe(403);
    expect((await revoke(mine.id, head)).status).toBe(200);
    expect((await revoke(theirs.id, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});
