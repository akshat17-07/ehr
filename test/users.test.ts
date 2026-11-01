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

describe('GET /admin/users/{id}', () => {
  const get = (id: string, who = asStaff('dev-admin', ['admin'])) => app.request(`/admin/users/${id}`, {}, who);

  it('gives one user with bundles', async () => {
    const id = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-billing'")).rows[0]?.id);
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, name: 'Amit Jain', type: 'staff', bundles: ['billing'], version: 1 });
  });

  it('404 for an unknown or bad id; 403 without user.view', async () => {
    expect((await get('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await get('dev-billing')).status).toBe(404);
    const id = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-billing'")).rows[0]?.id);
    expect((await get(id, asStaff('head-x', ['head_doctor']))).status).toBe(403);
  });
});

describe('PATCH /admin/users/{id}', () => {
  const patch = async (id: string, body: unknown, who = asStaff('dev-admin', ['admin'])) => {
    const res = await app.request(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, who);
    return { status: res.status, body: (await res.json()) as User & { error?: string; message?: string } };
  };
  const idOf = async (sub: string) => String((await db.query('SELECT id FROM users WHERE cognito_sub = $1', [sub])).rows[0]?.id);

  it('changes details with the version check and keeps the old row', async () => {
    const id = await idOf('dev-nurse');
    const ped = await departmentId('PED');
    const res = await patch(id, { version: 1, mobile: '9000000001', departmentIds: [ped], reason: 'moved to paediatrics' });
    expect(res).toMatchObject({ status: 200, body: { version: 2, mobile: '9000000001', departmentIds: [ped], name: 'Sunita Yadav' } });
    expect(await patch(id, { version: 1, name: 'Late edit' })).toMatchObject({ status: 409, body: { error: 'conflict' } });

    const { rows } = await db.query('SELECT version, reason FROM users_versions WHERE record_id = $1', [id]);
    expect(rows).toEqual([{ version: 1, reason: 'moved to paediatrics' }]);
  });

  it('clears optional details with null, but doctors keep their council details', async () => {
    const pharmacist = await idOf('dev-medical');
    expect((await patch(pharmacist, { version: 1, pharmacistRegNo: null })).body).not.toHaveProperty('pharmacistRegNo');
    const doctor = await idOf('dev-doctor');
    expect(await patch(doctor, { version: 1, councilRegNo: null })).toMatchObject({ status: 422, body: { message: 'doctors must keep: councilRegNo' } });
    expect(await patch(doctor, { version: 1, regValidTill: '2032-12-31' })).toMatchObject({ status: 200, body: { regValidTill: '2032-12-31' } });
  });

  it('422 for email or type changes, an empty change or a bad department; 404 unknown; 403 for Head Doctors', async () => {
    const id = await idOf('dev-gp');
    for (const body of [{ version: 1, email: 'new@x.in' }, { version: 1, type: 'admin' }, { version: 1 }, { version: 1, departmentIds: ['00000000-0000-4000-8000-000000000000'] }]) {
      expect((await patch(id, body)).status).toBe(422);
    }
    expect((await patch('00000000-0000-4000-8000-000000000000', { version: 1, name: 'Nobody' })).status).toBe(404);
    expect((await patch(id, { version: 1, name: 'Dr A Dubey' }, asStaff('dev-head-doctor', ['head_doctor']))).status).toBe(403);
  });
});

describe('POST /admin/users/{id}/deactivate', () => {
  const idOf = async (sub: string) => String((await db.query('SELECT id FROM users WHERE cognito_sub = $1', [sub])).rows[0]?.id);
  const post = async (id: string, body: unknown, who = asStaff('dev-admin', ['admin'])) => {
    const res = await app.request(`/admin/users/${id}/deactivate`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, who);
    return { status: res.status, body: (await res.json()) as User & { error?: string; message?: string } };
  };

  it('disables the Cognito account, marks the user inactive, and refuses their token at once', async () => {
    accounts.accounts.set('insurance@dev.local', { sub: 'dev-insurance', name: 'x', groups: ['insurance'], enabled: true });
    const id = await idOf('dev-insurance');
    expect(await post(id, { reason: 'left the hospital' })).toMatchObject({ status: 200, body: { active: false } });
    expect(accounts.accounts.get('insurance@dev.local')?.enabled).toBe(false);
    // The ID token is still unexpired, but the users row says inactive.
    const me = await app.request('/other/insurance/me', {}, asStaff('dev-insurance', ['insurance']));
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ error: 'account_disabled' });
    expect((await post(id, { reason: 'again, no change' })).body).toMatchObject({ active: false, version: 2 });
  });

  it('needs a reason; 403 for own account and for Head Doctors; 409 for the last Admin', async () => {
    const nurse = await idOf('dev-nurse');
    expect((await post(nurse, {})).status).toBe(422);
    expect((await post(nurse, { reason: 'not allowed' }, asStaff('dev-head-doctor', ['head_doctor']))).status).toBe(403);
    expect(await post(await idOf('dev-admin'), { reason: 'leaving soon' })).toMatchObject({
      status: 403,
      body: { message: 'nobody can deactivate their own account' },
    });
    // Another Admin, with no users row, tries to deactivate the only active Admin.
    expect(await post(await idOf('dev-admin'), { reason: 'last admin' }, asStaff('console-admin', ['admin']))).toMatchObject({
      status: 409,
      body: { error: 'last_admin' },
    });
  });
});

describe('POST /admin/users/{id}/reactivate', () => {
  const idOf = async (sub: string) => String((await db.query('SELECT id FROM users WHERE cognito_sub = $1', [sub])).rows[0]?.id);
  const post = async (action: string, id: string, body: unknown, who = asStaff('dev-admin', ['admin'])) => {
    const res = await app.request(`/admin/users/${id}/${action}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, who);
    return { status: res.status, body: (await res.json()) as User & { error?: string } };
  };

  it('enables the Cognito account and lets the user back in', async () => {
    accounts.accounts.set('medical@dev.local', { sub: 'dev-medical', name: 'x', groups: ['medical'], enabled: true });
    const id = await idOf('dev-medical');
    expect((await post('deactivate', id, { reason: 'contract paused' })).body).toMatchObject({ active: false });
    expect((await app.request('/staff/me', {}, asStaff('dev-medical', ['medical']))).status).toBe(401);

    expect(await post('reactivate', id, { reason: 'contract renewed' })).toMatchObject({ status: 200, body: { active: true } });
    expect(accounts.accounts.get('medical@dev.local')?.enabled).toBe(true);
    expect((await app.request('/staff/me', {}, asStaff('dev-medical', ['medical']))).status).toBe(200);

    const { rows } = await db.query('SELECT version, reason FROM users_versions WHERE record_id = $1 ORDER BY version', [id]);
    expect(rows.map((r) => r.reason).slice(-2)).toEqual(['contract paused', 'contract renewed']);
    expect((await post('reactivate', id, { reason: 'already active' })).body).toMatchObject({ active: true });
  });

  it('403 for Head Doctors and for own account', async () => {
    const nurse = await idOf('dev-nurse');
    expect((await post('reactivate', nurse, { reason: 'not allowed' }, asStaff('dev-head-doctor', ['head_doctor']))).status).toBe(403);
    expect((await post('reactivate', await idOf('dev-admin'), { reason: 'my own' })).status).toBe(403);
  });
});

describe('POST /admin/users/{id}/mfa-reset', () => {
  const idOf = async (sub: string) => String((await db.query('SELECT id FROM users WHERE cognito_sub = $1', [sub])).rows[0]?.id);
  const post = async (id: string, body: unknown, who = asStaff('dev-admin', ['admin'])) => {
    const res = await app.request(`/admin/users/${id}/mfa-reset`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, who);
    return { status: res.status, body: (await res.json()) as User & { error?: string } };
  };

  it('resets the authenticator app of an active user', async () => {
    accounts.accounts.set('reception@dev.local', { sub: 'dev-reception', name: 'x', groups: ['staff'], enabled: true });
    expect(await post(await idOf('dev-reception'), { reason: 'lost their phone' })).toMatchObject({ status: 200, body: { cognitoSub: 'dev-reception' } });
    expect(accounts.accounts.get('reception@dev.local')?.mfaResets).toBe(1);
  });

  it('needs a reason; 403 own account and Head Doctors; 409 for an inactive user', async () => {
    expect((await post(await idOf('dev-reception'), {})).status).toBe(422);
    expect((await post(await idOf('dev-admin'), { reason: 'my own phone' })).status).toBe(403);
    expect((await post(await idOf('dev-nurse'), { reason: 'lost phone' }, asStaff('dev-head-doctor', ['head_doctor']))).status).toBe(403);
    expect(await post(await idOf('dev-insurance'), { reason: 'lost phone' })).toMatchObject({ status: 409, body: { error: 'inactive' } });
  });
});

describe('POST /admin/users/{id}/promote-head-doctor', () => {
  const idOf = async (sub: string) => String((await db.query('SELECT id FROM users WHERE cognito_sub = $1', [sub])).rows[0]?.id);
  const post = async (id: string, body: unknown, who = asStaff('dev-admin', ['admin'])) => {
    const res = await app.request(`/admin/users/${id}/promote-head-doctor`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, who);
    return { status: res.status, body: (await res.json()) as User & { error?: string } };
  };

  it('moves an active doctor to Head Doctor, in Cognito and at once on their next request', async () => {
    accounts.accounts.set('surgeon@dev.local', { sub: 'dev-surgeon', name: 'x', groups: ['doctor'], enabled: true });
    expect(await post(await idOf('dev-surgeon'), { reason: 'new head of surgery' })).toMatchObject({ status: 200, body: { type: 'head_doctor' } });
    expect(accounts.accounts.get('surgeon@dev.local')?.groups).toEqual(['head_doctor']);
    // Their token still says doctor, but the users row decides.
    expect((await app.request('/admin/me', {}, asStaff('dev-surgeon', ['doctor']))).status).toBe(200);
  });

  it('409 unless an active doctor; 403 for Head Doctors', async () => {
    expect(await post(await idOf('dev-nurse'), { reason: 'not a doctor' })).toMatchObject({ status: 409, body: { error: 'wrong_type' } });
    expect((await post(await idOf('dev-surgeon'), { reason: 'already head' })).status).toBe(409);
    expect((await post(await idOf('dev-doctor'), { reason: 'not allowed' }, asStaff('dev-head-doctor', ['head_doctor']))).status).toBe(403);
  });
});

describe('POST /admin/users/{id}/demote-head-doctor', () => {
  const idOf = async (sub: string) => String((await db.query('SELECT id FROM users WHERE cognito_sub = $1', [sub])).rows[0]?.id);
  const post = async (id: string, body: unknown, who = asStaff('dev-admin', ['admin'])) => {
    const res = await app.request(`/admin/users/${id}/demote-head-doctor`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, who);
    return { status: res.status, body: (await res.json()) as User & { error?: string } };
  };

  it('moves a Head Doctor back to doctor, and the admin pages close to them at once', async () => {
    accounts.accounts.set('head-doctor@dev.local', { sub: 'dev-head-doctor', name: 'x', groups: ['head_doctor'], enabled: true });
    expect(await post(await idOf('dev-head-doctor'), { reason: 'stepped down' })).toMatchObject({ status: 200, body: { type: 'doctor' } });
    expect(accounts.accounts.get('head-doctor@dev.local')?.groups).toEqual(['doctor']);
    expect((await app.request('/admin/me', {}, asStaff('dev-head-doctor', ['head_doctor']))).status).toBe(403);
  });

  it('409 unless a Head Doctor; needs a reason', async () => {
    expect(await post(await idOf('dev-doctor'), { reason: 'not a head' })).toMatchObject({ status: 409, body: { error: 'wrong_type' } });
    expect((await post(await idOf('dev-surgeon'), {})).status).toBe(422);
  });
});

describe('GET /admin/users/{id}/versions', () => {
  const idOf = async (sub: string) => String((await db.query('SELECT id FROM users WHERE cognito_sub = $1', [sub])).rows[0]?.id);

  it('lists every version, oldest first, with who, when and why', async () => {
    const res = await app.request(`/admin/users/${await idOf('dev-nurse')}/versions`, {}, asStaff('dev-admin', ['admin']));
    expect(res.status).toBe(200);
    const versions = (await res.json()) as { version: number; by: string; reason?: string; data: User }[];
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[1]).toMatchObject({ by: 'dev-admin', reason: 'moved to paediatrics', data: { mobile: '9000000001', active: true } });
    expect(versions[0]?.data).not.toHaveProperty('bundles');
  });

  it('keeps dates as YYYY-MM-DD in old and current versions', async () => {
    const res = await app.request(`/admin/users/${await idOf('dev-doctor')}/versions`, {}, asStaff('dev-admin', ['admin']));
    const versions = (await res.json()) as { data: User }[];
    expect(versions.at(-1)?.data.regValidTill).toBe('2032-12-31');
    for (const v of versions) expect(v.data.regValidTill).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('404 for an unknown id; 403 without audit.read', async () => {
    expect((await app.request('/admin/users/nope/versions', {}, asStaff('dev-admin', ['admin']))).status).toBe(404);
    expect((await app.request('/admin/users/00000000-0000-4000-8000-000000000000/versions', {}, asStaff('dev-admin', ['admin']))).status).toBe(404);
    const nurse = await idOf('dev-nurse');
    expect((await app.request(`/admin/users/${nurse}/versions`, {}, asStaff('dev-reception', ['staff']))).status).toBe(403);
  });
});
