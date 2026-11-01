import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { DEV_USERS, seedDev } from '../src/db/seed-dev.js';
import type { User } from '../src/modules/users/users.js';
import { fakeStaffAccounts } from './fake-staff-accounts.js';

const db = await openLocalDb();
await seedDev(db);
const accounts = fakeStaffAccounts();
const app = createApp({ db: async () => db, staffAccounts: accounts });

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

describe('POST /admin/users', () => {
  const admin = asStaff('dev-admin', ['admin']);
  const post = async (body: unknown, who = admin) => {
    const res = await app.request('/admin/users', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, who);
    return { status: res.status, body: (await res.json()) as User & { error?: string; message?: string; issues?: { path: string[] }[] } };
  };
  const nurse = { name: 'Rekha Soni', email: 'Rekha@Hospital.in', mobile: '+91 98765-43210', type: 'nurse' };

  it('invites the user in Cognito, adds the group and saves the user with bundles', async () => {
    const med = await departmentId('MED');
    const { status, body } = await post({ ...nurse, departmentIds: [med, med], bundles: ['records', 'reception'] });
    expect(status).toBe(201);
    expect(body).toMatchObject({
      email: 'rekha@hospital.in',
      mobile: '9876543210',
      type: 'nurse',
      departmentIds: [med],
      bundles: ['reception', 'records'],
      active: true,
      version: 1,
    });
    expect(accounts.accounts.get('rekha@hospital.in')).toMatchObject({ sub: body.cognitoSub, groups: ['nurse'], enabled: true });
    expect((await list('?q=rekha')).body.items).toHaveLength(1);
  });

  it('409 when the email is taken, here or in Cognito', async () => {
    expect(await post({ ...nurse, email: 'REKHA@hospital.in' })).toMatchObject({ status: 409, body: { error: 'email_taken' } });
    await accounts.invite({ email: 'only-in-cognito@x.in', name: 'x' });
    expect(await post({ ...nurse, email: 'only-in-cognito@x.in' })).toMatchObject({ status: 409, body: { error: 'email_taken' } });
  });

  it('doctors need council details; head doctor can only be promoted', async () => {
    const doctor = { ...nurse, email: 'dr.new@x.in', type: 'doctor' };
    const res = await post(doctor);
    expect(res.status).toBe(422);
    expect(res.body.issues?.map((i) => i.path[0]).sort()).toEqual(['councilName', 'councilRegNo', 'regValidTill']);
    const ok = await post({ ...doctor, councilName: 'MPMC', councilRegNo: 'MP-77', regValidTill: '2031-03-31' });
    expect(ok).toMatchObject({ status: 201, body: { regValidTill: '2031-03-31' } });
    expect((await post({ ...nurse, email: 'hd@x.in', type: 'head_doctor' })).status).toBe(422);
  });

  it('422 for a bad mobile, unknown field, department or bundle', async () => {
    expect((await post({ ...nurse, email: 'a1@x.in', mobile: '12345' })).status).toBe(422);
    expect((await post({ ...nurse, email: 'a2@x.in', role: 'admin' })).status).toBe(422);
    expect(await post({ ...nurse, email: 'a3@x.in', departmentIds: ['00000000-0000-4000-8000-000000000000'] })).toMatchObject({
      status: 422,
      body: { message: expect.stringContaining('unknown or inactive department') },
    });
    expect(await post({ ...nurse, email: 'a4@x.in', bundles: ['everything'] })).toMatchObject({ status: 422, body: { message: 'unknown bundle: everything' } });
    expect(accounts.accounts.has('a3@x.in')).toBe(false); // checked before any account is made
  });

  it('disables the Cognito account if saving fails, so nothing is left half-made', async () => {
    accounts.failAddToGroup = true;
    try {
      expect((await post({ ...nurse, email: 'half@x.in' })).status).toBe(500);
    } finally {
      accounts.failAddToGroup = false;
    }
    expect(accounts.accounts.get('half@x.in')?.enabled).toBe(false);
    expect((await list('?q=half@')).body.items).toEqual([]);
  });

  it('only with user.create: a Head Doctor can not add users', async () => {
    expect((await post({ ...nurse, email: 'b1@x.in' }, asStaff('dev-head-doctor', ['head_doctor']))).status).toBe(403);
  });
});
