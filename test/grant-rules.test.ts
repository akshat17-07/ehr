import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedId } from '../src/db/table.js';
import { seedDev } from '../src/db/seed-dev.js';
import { fakeStaffAccounts } from './fake-staff-accounts.js';

const db = await openLocalDb();
await seedDev(db);
const accounts = fakeStaffAccounts();
const app = createApp({ db: async () => db, staffAccounts: accounts });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);
const headId = seedId('a0000000', 2);
const surgeonId = seedId('a0000000', 4);
const med = seedId('de000000', 1);

let made = 0;
const addRule = async (grantorId: string, mayGrant: string[], scope: string, departmentId: string | null, status = 'active') => {
  const id = randomUUID();
  made += 1;
  await db.query(
    // created_at set a minute apart, so the order doesn't hang on the clock.
    `INSERT INTO grant_rules (id, status, created_at, created_by, updated_by, grantor_id, may_grant, scope, department_id, max_days)
     VALUES ($1, $2, $7, 'test', 'test', $3, $4, $5, $6, 30)`,
    [id, status, grantorId, JSON.stringify(mayGrant), scope, departmentId, new Date(Date.UTC(2026, 0, 1, 0, made))],
  );
  return id;
};

describe('GET /admin/grant-rules', () => {
  it('lists the rules, active first, and filters by grantor', async () => {
    const ended = await addRule(headId, ['mtp.view'], 'all', null, 'ended');
    const rule = await addRule(headId, ['pcpndt.view', 'pcpndt.write'], 'department', med);
    const other = await addRule(surgeonId, ['document.view'], 'all', null);
    const res = await app.request('/admin/grant-rules', {}, head);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }[]).map((r) => r.id)).toEqual([rule, other, ended]);
    const mine = (await (await app.request(`/admin/grant-rules?grantorUserId=${headId}`, {}, admin)).json()) as object[];
    expect(mine).toEqual([
      { id: rule, version: 1, grantorUserId: headId, mayGrant: ['pcpndt.view', 'pcpndt.write'], scope: 'department', departmentId: med, maxDays: 30, active: true },
      { id: ended, version: 1, grantorUserId: headId, mayGrant: ['mtp.view'], scope: 'all', maxDays: 30, active: false },
    ]);
  });

  it('422 for a bad grantorUserId; 403 for a doctor', async () => {
    expect((await app.request('/admin/grant-rules?grantorUserId=nope', {}, admin)).status).toBe(422);
    expect((await app.request('/admin/grant-rules', {}, asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});

describe('POST /admin/grant-rules', () => {
  const post = (body: unknown, who = admin) =>
    app.request('/admin/grant-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('adds a rule for a Head Doctor, with mayGrant sorted', async () => {
    const res = await post({ grantorUserId: headId, mayGrant: ['sensitive.view', 'pcpndt.view', 'sensitive.view'], scope: 'department', departmentId: med, maxDays: 90 });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ grantorUserId: headId, mayGrant: ['pcpndt.view', 'sensitive.view'], scope: 'department', departmentId: med, maxDays: 90, active: true, version: 1 });
  });

  it('422 for role.*, user.*, Admin-only or unknown permissions, a bad scope, or a grantor who is not a Head Doctor', async () => {
    const good = { grantorUserId: headId, mayGrant: ['document.view'], scope: 'all', maxDays: 30 };
    for (const mayGrant of [['role.promote_head_doctor'], ['user.create'], ['grant_rule.manage'], ['no.such']]) {
      expect((await post({ ...good, mayGrant })).status).toBe(422);
    }
    expect((await post({ ...good, departmentId: med })).status).toBe(422);
    expect((await post({ ...good, scope: 'department' })).status).toBe(422);
    expect((await post({ ...good, scope: 'department', departmentId: randomUUID() })).status).toBe(422);
    expect((await post({ ...good, maxDays: 366 })).status).toBe(422);
    expect((await post({ ...good, grantorUserId: seedId('a0000000', 3) })).status).toBe(422);
    expect((await post(good, head)).status).toBe(403);
  });

  describe('PATCH /admin/grant-rules/{id}', () => {
    const patch = (id: string, body: unknown, who = admin) =>
      app.request(`/admin/grant-rules/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
    const make = async () =>
      (await (await post({ grantorUserId: headId, mayGrant: ['document.view'], scope: 'department', departmentId: med, maxDays: 30 })).json()) as { id: string };

    it('changes what may be granted, the scope and length, with a version check', async () => {
      const { id } = await make();
      const res = await patch(id, { version: 1, mayGrant: ['mtp.view', 'document.view'], scope: 'all', maxDays: 7, reason: 'covers the whole hospital' });
      expect(res.status).toBe(200);
      const rule = (await res.json()) as object;
      expect(rule).toMatchObject({ mayGrant: ['document.view', 'mtp.view'], scope: 'all', maxDays: 7, active: true, version: 2 });
      expect(rule).not.toHaveProperty('departmentId');
      expect((await patch(id, { version: 1, maxDays: 9 })).status).toBe(409);
    });

    it('ends a rule and starts it again', async () => {
      const { id } = await make();
      expect(await (await patch(id, { version: 1, active: false, reason: 'not needed now' })).json()).toMatchObject({ active: false, version: 2 });
      expect(await (await patch(id, { version: 2, active: true })).json()).toMatchObject({ active: true, version: 3 });
    });

    it('404 for no rule; 422 for nothing to change or a bad scope; 403 for a Head Doctor', async () => {
      const { id } = await make();
      expect((await patch(randomUUID(), { version: 1, maxDays: 9 })).status).toBe(404);
      expect((await patch(id, { version: 1 })).status).toBe(422);
      expect((await patch(id, { version: 1, scope: 'department' })).status).toBe(422);
      expect((await patch(id, { version: 1, mayGrant: ['user.create'] })).status).toBe(422);
      expect((await patch(id, { version: 1, maxDays: 9 }, head)).status).toBe(403);
    });
  });

  it('demoting the Head Doctor ends their rules, with the reason kept', async () => {
    accounts.accounts.set('head-doctor@dev.local', { sub: 'dev-head-doctor', name: 'x', groups: ['head_doctor'], enabled: true });
    const res = await app.request(`/admin/users/${headId}/demote-head-doctor`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'stepped down' }) }, admin);
    expect(res.status).toBe(200);
    const rules = (await (await app.request(`/admin/grant-rules?grantorUserId=${headId}`, {}, admin)).json()) as { id: string; active: boolean }[];
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.every((r) => !r.active)).toBe(true);
    // Five were active: the one from the list test, the one added above and the three from the PATCH tests.
    const { rows } = await db.query("SELECT record_id FROM grant_rules_versions WHERE reason = 'stepped down'");
    expect(rows).toHaveLength(5);
  });
});
