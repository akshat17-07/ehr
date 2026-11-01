import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { DEV_USERS, seedDev } from '../src/db/seed-dev.js';
import type { User } from '../src/modules/users/users.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

function asStaff(sub: string, groups: string[]) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}

async function list(query = '', who = asStaff('dev-admin', ['admin'])) {
  const res = await app.request(`/admin/users${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as { items: User[]; nextCursor?: string } };
}
const names = (items: User[]) => items.map((u) => u.name);
const departmentId = async (code: string) =>
  String((await db.query('SELECT id FROM departments WHERE code = $1', [code])).rows[0]?.id);

describe('GET /admin/users', () => {
  it('lists every user A to Z, with bundles and details', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(names(body.items)).toEqual([...DEV_USERS.map((u) => u.name)].sort());
    const reception = body.items.find((u) => u.cognitoSub === 'dev-reception');
    expect(reception).toMatchObject({ type: 'staff', bundles: ['reception'], active: true, departmentIds: [] });
    const doctor = body.items.find((u) => u.cognitoSub === 'dev-doctor');
    expect(doctor).toMatchObject({ councilName: 'Madhya Pradesh Medical Council', regValidTill: '2030-12-31', bundles: [] });
    expect(doctor).not.toHaveProperty('pharmacistRegNo');
  });

  it('filters by type, department, active and name or email', async () => {
    expect(names((await list('?type=doctor')).body.items)).toEqual(['Dr Neha Gupta', 'Dr Vikram Singh']);
    expect(names((await list(`?departmentId=${await departmentId('ORT')}`)).body.items)).toEqual(['Dr Vikram Singh']);
    expect(names((await list('?q=SHARMA')).body.items)).toEqual(['Dr Rakesh Sharma']);
    expect(names((await list('?q=billing@')).body.items)).toEqual(['Amit Jain']);
    expect(names((await list('?q=a%25')).body.items)).toEqual([]); // % is a letter here, not "anything"

    await db.query("UPDATE users SET active = false WHERE cognito_sub = 'dev-gp'");
    expect(names((await list('?active=false')).body.items)).toEqual(['Dr Anil Dubey']);
    expect((await list('?active=true')).body.items).toHaveLength(DEV_USERS.length - 1);
  });

  it('pages', async () => {
    const first = await list('?limit=6');
    const second = await list(`?limit=6&cursor=${first.body.nextCursor}`);
    expect(names([...first.body.items, ...second.body.items])).toEqual([...DEV_USERS.map((u) => u.name)].sort());
  });

  it('422 for bad filters; 403 for nurses and for a Head Doctor denied user.view', async () => {
    for (const q of ['?type=cook', '?departmentId=MED', '?q=a', '?active=1']) expect((await list(q)).status).toBe(422);
    expect((await list('', asStaff('n-1', ['nurse']))).status).toBe(403);
    await db.query(
      `INSERT INTO user_permissions (id, status, created_by, updated_by, user_id, allow, deny)
       VALUES (gen_random_uuid(), 'active', 'a', 'a', 'head-x', '[]', '["user.view"]')`,
    );
    expect(await list('', asStaff('head-x', ['head_doctor']))).toMatchObject({ status: 403 });
  });
});
