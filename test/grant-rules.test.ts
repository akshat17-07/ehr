import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedId } from '../src/db/table.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

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
