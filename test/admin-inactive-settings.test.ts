import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { DEFAULT_INACTIVE_SETTING, ruleFor } from '../src/modules/access/inactive-settings.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);
const doctor = asStaff('dev-doctor', ['doctor']);
const doctorId = seedId('a0000000', 3);
const med = seedId('de000000', 1);
const day = 86_400_000;

type Setting = { id: string; version: number; appliesTo: string; role?: string; userId?: string; mode: string; days: number; approver: string; accessHours: number };
const get = async (who = admin) => {
  const res = await app.request('/admin/settings/inactive-access', {}, who);
  return { status: res.status, body: (await res.json()) as Setting[] };
};
const patch = async (body: unknown, who = admin) => {
  const res = await app.request('/admin/settings/inactive-access', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  return { status: res.status, body: (await res.json()) as Setting[] };
};
const rule = (role: string, days: number, extra: Partial<Setting> = {}) => ({ appliesTo: 'role', role, mode: 'request_after_days', days, approver: 'head_doctor', accessHours: 24, ...extra });

let made = 0;
/** A new patient with an encounter, last active `daysAgo` days ago. */
async function patientWithEncounter(daysAgo: number) {
  made += 1;
  const { rows } = await db.query(
    `INSERT INTO patients (id, status, created_by, updated_by, uhid, name, name_search, sex, labels, allergies, last_activity_at)
     VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, 'Inactive Test', 'inactive test', 'F', '[]', '[]', $2) RETURNING id`,
    [`U98${String(made).padStart(6, '0')}`, new Date(Date.now() - daysAgo * day)],
  );
  const patientId = String(rows[0]!.id);
  const enc = await db.query(
    `INSERT INTO encounters (id, status, created_by, updated_by, patient_id, type, department_id, doctor_id, started_at)
     VALUES (gen_random_uuid(), 'closed', 'x', 'x', $1, 'OPD', $2, $3, $4) RETURNING id`,
    [patientId, med, doctorId, new Date(Date.now() - daysAgo * day)],
  );
  return { patientId, encounterId: String(enc.rows[0]!.id) };
}
const open = async (encounterId: string, who = doctor) => (await app.request(`/staff/encounters/${encounterId}`, {}, who)).status;

describe('GET and PATCH /admin/settings/inactive-access', () => {
  it('starts empty (the default applies), then holds what the Admin set, roles before users', async () => {
    expect(await get()).toEqual({ status: 200, body: [] });
    const { status, body } = await patch({ settings: [{ ...rule('nurse', 30), approver: 'admin', accessHours: 2 }, { appliesTo: 'user', userId: doctorId, mode: 'any_record', days: 10, approver: 'head_doctor', accessHours: 24 }], reason: 'new policy' });
    expect(status).toBe(200);
    expect(body.map((s) => [s.appliesTo, s.role ?? s.userId])).toEqual([['role', 'nurse'], ['user', doctorId]]);
    expect(body[0]).toMatchObject({ mode: 'request_after_days', days: 30, approver: 'admin', accessHours: 2, version: 1 });
    expect((await get()).body).toEqual(body);
  });

  it('replaces the list: an unchanged row stays, a changed one is edited with history, a missing one ends', async () => {
    const before = (await get()).body;
    const nurse = before.find((s) => s.role === 'nurse')!;
    const { body } = await patch({ settings: [rule('nurse', 14, { approver: 'admin', accessHours: 2 }), rule('staff', 5)], reason: 'tighter' });
    expect(body.map((s) => [s.role, s.days])).toEqual([['nurse', 14], ['staff', 5]]);
    expect(body[0]).toMatchObject({ id: nurse.id, version: 2 });
    const history = await db.query('SELECT reason FROM inactive_settings_versions WHERE record_id = $1', [nurse.id]);
    expect(history.rows[0]).toMatchObject({ reason: 'tighter' });
    const ended = await db.query("SELECT status FROM inactive_settings WHERE user_id = $1", [doctorId]);
    expect(ended.rows).toEqual([{ status: 'ended' }]);
    // the same list again changes nothing
    expect((await patch({ settings: [rule('nurse', 14, { approver: 'admin', accessHours: 2 }), rule('staff', 5)] })).body[0]).toMatchObject({ version: 2 });
    expect((await patch({ settings: [] })).body).toEqual([]);
  });

  it('422 for a bad setting, a repeat, or an unknown user; 403 for anyone but the Admin', async () => {
    expect((await patch({ settings: [rule('nurse', 0)] })).status).toBe(422);
    expect((await patch({ settings: [rule('nurse', 10, { accessHours: 0 })] })).status).toBe(422);
    expect((await patch({ settings: [rule('wizard', 10)] })).status).toBe(422);
    expect((await patch({ settings: [rule('nurse', 10, { approver: 'nurse' })] })).status).toBe(422);
    expect((await patch({ settings: [{ appliesTo: 'role', mode: 'any_record', days: 10, approver: 'admin', accessHours: 1 }] })).status).toBe(422);
    expect((await patch({ settings: [{ ...rule('nurse', 10), userId: doctorId }] })).status).toBe(422);
    expect((await patch({ settings: [rule('nurse', 10), rule('nurse', 20)] })).status).toBe(422);
    expect((await patch({ settings: [{ appliesTo: 'user', userId: randomUUID(), mode: 'any_record', days: 10, approver: 'admin', accessHours: 1 }] })).status).toBe(422);
    expect((await patch({})).status).toBe(422);
    expect((await patch({ settings: [] }, head)).status).toBe(403);
    expect((await get(head)).status).toBe(403);
    expect((await get(doctor)).status).toBe(403);
  });
});

describe('the settings at work', () => {
  it('default: a doctor is stopped at a patient idle for 20 days; a role setting of 30 days opens it; a user setting wins over the role', async () => {
    const { encounterId } = await patientWithEncounter(20);
    expect(await open(encounterId)).toBe(403);
    await patch({ settings: [rule('doctor', 30)] });
    expect(await open(encounterId)).toBe(200);
    await patch({ settings: [rule('doctor', 30), { ...rule('x', 5), appliesTo: 'user', role: undefined, userId: doctorId }] });
    expect(await open(encounterId)).toBe(403);
    await patch({ settings: [] });
    expect(await open(encounterId)).toBe(403);
  });

  it('any_record opens any patient, however long idle', async () => {
    const { encounterId } = await patientWithEncounter(400);
    await patch({ settings: [rule('doctor', 10, { mode: 'any_record' })] });
    expect(await open(encounterId)).toBe(200);
    await patch({ settings: [] });
    expect(await open(encounterId)).toBe(403);
  });

  it('the inactive badge uses the shortest limit anyone has', async () => {
    const { patientId } = await patientWithEncounter(5);
    const read = async () => ((await (await app.request(`/staff/patients/${patientId}`, {}, admin)).json()) as { inactive: boolean }).inactive;
    expect(await read()).toBe(false);
    await patch({ settings: [rule('nurse', 3)] });
    expect(await read()).toBe(true);
    await patch({ settings: [rule('nurse', 90)] });
    expect(await read()).toBe(false);
    await patch({ settings: [] });
  });
});

describe('several groups', () => {
  it('the strictest role setting wins: a limit beats any_record, then fewest days; the user setting beats them all', async () => {
    const both = () => ruleFor(db, 'dev-doctor', ['doctor', 'nurse']);
    await patch({ settings: [rule('doctor', 10, { mode: 'any_record' }), rule('nurse', 30)] });
    expect(await both()).toMatchObject({ mode: 'request_after_days', days: 30 });
    await patch({ settings: [rule('doctor', 25), rule('nurse', 15)] });
    expect(await both()).toMatchObject({ mode: 'request_after_days', days: 15 });
    await patch({ settings: [rule('nurse', 15), rule('doctor', 25), { ...rule('x', 40), appliesTo: 'user', role: undefined, userId: doctorId }] });
    expect(await both()).toMatchObject({ days: 40 });
    await patch({ settings: [] });
    expect(await both()).toEqual(DEFAULT_INACTIVE_SETTING);
  });
});

describe('approving an access request follows the requester setting', () => {
  const request = async () => {
    const { patientId } = await patientWithEncounter(60);
    const { rows } = await db.query(
      `INSERT INTO access_requests (id, status, created_by, updated_by, patient_id, requested_by, reason) VALUES (gen_random_uuid(), 'pending', 'dev-nurse', 'dev-nurse', $1, 'dev-nurse', 'follow-up') RETURNING id`,
      [patientId],
    );
    return String(rows[0]!.id);
  };
  const approve = async (id: string, body: unknown, who: ReturnType<typeof asStaff>) =>
    app.request(`/admin/access-requests/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('the hours come from the setting unless named; an Admin-only approver refuses a Head Doctor', async () => {
    await patch({ settings: [rule('nurse', 10, { approver: 'admin', accessHours: 2 })] });
    const id = await request();
    expect((await approve(id, {}, head)).status).toBe(403);
    const res = await approve(id, {}, admin);
    expect(res.status).toBe(200);
    const until = new Date(((await res.json()) as { validUntil: string }).validUntil).getTime() - Date.now();
    expect(until).toBeGreaterThan(1.9 * 3_600_000);
    expect(until).toBeLessThanOrEqual(2 * 3_600_000);

    await patch({ settings: [rule('nurse', 10, { accessHours: 2 })] });
    const other = await request();
    const named = await approve(other, { hours: 5 }, head);
    expect(named.status).toBe(200);
    expect(new Date(((await named.json()) as { validUntil: string }).validUntil).getTime() - Date.now()).toBeGreaterThan(4.9 * 3_600_000);
    await patch({ settings: [] });
  });
});
