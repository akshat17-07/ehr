import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const reception = asStaff('dev-reception', ['staff']);
const doctorId = seedId('a0000000', 3);
const med = seedId('de000000', 1);
const today = indiaDate();

type Item = { patientId: string; type: string; status: string; patient: { uhid: string } };
const list = async (query = '', who = doctor) => {
  const res = await app.request(`/staff/encounters${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as { items: Item[]; nextCursor?: string } };
};
const post = (body: unknown, who = doctor) =>
  app.request('/staff/encounters', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
const patch = (id: string, body: unknown, who = doctor) =>
  app.request(`/staff/encounters/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
const open = async (patientId: string) =>
  ((await (await post({ patientId, type: 'OPD', departmentId: med, doctorId })).json()) as { id: string }).id;
const checkIn = (n: number) => app.request(`/staff/appointments/${seedId('a9900000', n)}/check-in`, { method: 'POST' }, reception);

// Ramesh (dev-doctor, MED) then Rahul (dev-surgeon, SUR) arrive.
expect((await checkIn(1)).status).toBe(200);
expect((await checkIn(3)).status).toBe(200);

describe('GET /staff/encounters', () => {
  it("lists today's encounters in arrival order, each with the patient", async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((e) => e.patient.uhid)).toEqual(['U24000001', 'U26000005']);
    expect(body.items[0]).toMatchObject({ type: 'OPD', status: 'open', doctorId, departmentId: med });
  });

  it('filters by doctor, department, type and status; pages; other days are empty', async () => {
    expect((await list(`?doctorId=${doctorId}`)).body.items.map((e) => e.patient.uhid)).toEqual(['U24000001']);
    expect((await list(`?departmentId=${seedId('de000000', 2)}`)).body.items.map((e) => e.patient.uhid)).toEqual(['U26000005']);
    expect((await list('?type=IPD')).body.items).toEqual([]);
    expect((await list('?status=closed')).body.items).toEqual([]);
    const first = await list('?limit=1');
    expect(first.body.items).toHaveLength(1);
    const second = await list(`?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((e) => e.patient.uhid)).toEqual(['U26000005']);
    const tomorrow = new Date(new Date(`${today}T12:00:00+05:30`).getTime() + 86_400_000).toISOString().slice(0, 10);
    expect((await list(`?date=${tomorrow}`)).body.items).toEqual([]);
  });

  it('422 for a bad filter; 403 without encounter.view', async () => {
    expect((await list('?type=XYZ')).status).toBe(422);
    expect((await list('?date=01-11-2026')).status).toBe(422);
    expect((await list('', reception)).status).toBe(403);
  });
});

describe('POST /staff/encounters', () => {
  const kavita = seedId('9a710000', 4);
  const irfan = seedId('9a710000', 3);

  it('opens a walk-in or emergency encounter and counts it as activity', async () => {
    const res = await post({ patientId: kavita, type: 'ER', departmentId: med, doctorId });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ patientId: kavita, type: 'ER', status: 'open', createdBy: 'dev-doctor' });
    expect((await db.query('SELECT last_activity_at FROM patients WHERE id = $1', [kavita])).rows[0]?.last_activity_at).toBeInstanceOf(Date);
  });

  it("with an appointment, checks it in: arrived, and the encounter takes the visit's type", async () => {
    const appointmentId = seedId('a9900000', 2);
    const res = await post({ patientId: irfan, type: 'ER', departmentId: med, doctorId, appointmentId });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ patientId: irfan, type: 'ER', appointmentId });
    expect((await db.query('SELECT status FROM appointments WHERE id = $1', [appointmentId])).rows[0]).toEqual({ status: 'arrived' });
    expect((await post({ patientId: irfan, type: 'OPD', departmentId: med, doctorId, appointmentId })).status).toBe(409);
  });

  it("422 for another patient's appointment, a doctor outside the department or an unknown patient; 403 for reception", async () => {
    const appointmentId = seedId('a9900000', 3);
    expect((await post({ patientId: kavita, type: 'OPD', departmentId: med, doctorId, appointmentId })).status).toBe(422);
    expect((await post({ patientId: kavita, type: 'OPD', departmentId: seedId('de000000', 2), doctorId })).status).toBe(422);
    expect((await post({ patientId: seedId('9a710000', 999), type: 'OPD', departmentId: med, doctorId })).status).toBe(422);
    expect((await post({ patientId: kavita, type: 'XYZ', departmentId: med, doctorId })).status).toBe(422);
    expect((await post({ patientId: kavita, type: 'OPD', departmentId: med, doctorId }, reception)).status).toBe(403);
  });
});

describe('GET /staff/encounters/{id}', () => {
  const get = (id: string, who = doctor) => app.request(`/staff/encounters/${id}`, {}, who);

  it('returns the encounter with its patient and its (still empty) parts', async () => {
    const { rows } = await db.query('SELECT id FROM encounters WHERE appointment_id = $1', [seedId('a9900000', 1)]);
    const id = String(rows[0]?.id);
    const res = await get(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, type: 'OPD', patient: { uhid: 'U24000001' }, vitals: [], notes: [], diagnoses: [], prescriptions: [] });
  });

  it('403 for an inactive patient without access; 404 for none; 403 without encounter.view', async () => {
    const { rows } = await db.query(
      "INSERT INTO encounters (id, status, created_by, updated_by, patient_id, type, department_id, doctor_id, started_at) VALUES ($1, 'closed', 'x', 'x', $2, 'OPD', $3, $4, '2024-01-05T10:00:00Z') RETURNING id",
      [seedId('e0c00000', 1), seedId('9a710000', 5), med, doctorId],
    );
    await db.query("UPDATE patients SET last_activity_at = '2024-01-05T10:00:00Z' WHERE id = $1", [seedId('9a710000', 5)]);
    const old = String(rows[0]?.id);
    expect(await (await get(old)).json()).toMatchObject({ error: 'inactive_patient' });
    expect((await get(old, asStaff('dev-head-doctor', ['head_doctor']))).status).toBe(200);
    expect((await get(seedId('e0c00000', 999))).status).toBe(404);
    expect((await get('nope')).status).toBe(404);
    expect((await get(old, reception)).status).toBe(403);
  });
});

describe('PATCH /staff/encounters/{id}', () => {
  const sita = seedId('9a710000', 2);
  const headDoctorId = seedId('a0000000', 2);

  it('moves an open encounter to another doctor and makes it IPD, keeping the old version and the reason', async () => {
    const id = await open(sita);
    const res = await patch(id, { version: 1, doctorId: headDoctorId, type: 'IPD', reason: 'admitted for observation' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2, doctorId: headDoctorId, type: 'IPD', departmentId: med });
    const history = await db.query('SELECT version, reason FROM encounters_versions WHERE record_id = $1', [id]);
    expect(history.rows).toEqual([{ version: 1, reason: 'admitted for observation' }]);
    expect((await patch(id, { version: 1, type: 'OPD' })).status).toBe(409);
  });

  it('422 for a doctor outside the department or a missing version; 409 once closed', async () => {
    const id = await open(sita);
    expect((await patch(id, { version: 1, departmentId: seedId('de000000', 2) })).status).toBe(422);
    expect((await patch(id, { type: 'IPD' })).status).toBe(422);
    await db.query("UPDATE encounters SET status = 'closed' WHERE id = $1", [id]);
    expect(await (await patch(id, { version: 1, type: 'IPD' })).json()).toMatchObject({ error: 'closed' });
    expect((await patch(seedId('e0c00000', 999), { version: 1, type: 'IPD' })).status).toBe(404);
  });
});
