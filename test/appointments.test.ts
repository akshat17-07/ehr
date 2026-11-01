import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

function asStaff(sub: string, groups: string[]) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}
const reception = asStaff('dev-reception', ['staff']);
const today = indiaDate();
const doctorId = seedId('a0000000', 3);
const surgeonId = seedId('a0000000', 4);
const med = seedId('de000000', 1);

type Appointment = { id: string; status: string; at: string; doctorId: string; patient: { uhid: string; name: string } };
const list = async (query: string, who = reception) => {
  const res = await app.request(`/staff/appointments?${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as Appointment[] };
};
const uhids = async (query: string) => (await list(query)).body.map((a) => a.patient.uhid);
const post = (path: string, body: unknown, who = reception) =>
  app.request(`/staff/appointments${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
/** A time in India `days` from today. */
const slot = (days: number, time: string) => new Date(new Date(`${today}T${time}:00+05:30`).getTime() + days * 86_400_000).toISOString();
const kavita = seedId('9a710000', 4);
const patch = (id: string, body: unknown, who = reception) =>
  app.request(`/staff/appointments/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
const bookOne = async (at: string, doctor = doctorId) =>
  ((await (await post('', { patientId: kavita, doctorId: doctor, departmentId: med, at })).json()) as { id: string }).id;

describe('GET /staff/appointments', () => {
  it("lists a day's appointments in time order, with the patient", async () => {
    const { status, body } = await list(`date=${today}`);
    expect(status).toBe(200);
    expect(body.map((a) => [a.patient.uhid, a.status])).toEqual([['U24000001', 'booked'], ['U25000003', 'booked'], ['U26000005', 'booked']]);
    expect(body[0]).toMatchObject({ doctorId, departmentId: med, durationMin: 10, at: new Date(`${today}T10:00:00+05:30`).toISOString() });
    expect(body[0]?.patient).toMatchObject({ name: 'Ramesh Kumar Sharma', inactive: false });
  });

  it('filters by doctor, department and status', async () => {
    expect(await uhids(`date=${today}&doctorId=${surgeonId}`)).toEqual(['U26000005']);
    expect(await uhids(`date=${today}&departmentId=${med}`)).toEqual(['U24000001', 'U25000003']);
    expect(await uhids(`date=${today}&status=arrived`)).toEqual([]);
    expect(await uhids('date=2020-01-01')).toEqual([]);
  });

  it('shows a booked appointment of an earlier day as no_show', async () => {
    const yesterday = new Date(`${today}T09:00:00+05:30`).getTime() - 86_400_000;
    await db.query(
      `INSERT INTO appointments (id, status, created_by, updated_by, patient_id, doctor_id, department_id, at, ends_at, duration_min)
       VALUES (gen_random_uuid(), 'booked', 'x', 'x', $1, $2, $3, $4, $5, 10)`,
      [seedId('9a710000', 4), doctorId, med, new Date(yesterday), new Date(yesterday + 600_000)],
    );
    const date = indiaDate(new Date(yesterday));
    expect((await list(`date=${date}`)).body.map((a) => a.status)).toEqual(['no_show']);
    expect(await uhids(`date=${date}&status=no_show`)).toEqual(['U25000004']);
    expect(await uhids(`date=${date}&status=booked`)).toEqual([]);
  });

  it('422 without a date; 403 without appointment.view', async () => {
    expect((await list('')).status).toBe(422);
    expect((await list(`date=${today}&status=late`)).status).toBe(422);
    expect((await list(`date=${today}`, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('POST /staff/appointments', () => {
  const book = (body: Record<string, unknown>) => post('', { patientId: kavita, doctorId, departmentId: med, ...body });

  it('books a slot (10 minutes unless told), with the patient', async () => {
    const res = await book({ at: slot(1, '09:30'), note: 'BP review' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'booked', patientId: kavita, doctorId, departmentId: med, at: slot(1, '09:30'),
      durationMin: 10, note: 'BP review', createdBy: 'dev-reception', patient: { uhid: 'U25000004' } });
    expect((await book({ at: slot(1, '09:40'), durationMin: 20 })).status).toBe(201);
  });

  it('409 when the slot overlaps a booked one; free again for another doctor', async () => {
    expect((await book({ at: slot(1, '09:35') })).status).toBe(409);
    expect((await book({ at: slot(1, '09:20'), durationMin: 15 })).status).toBe(409);
    expect((await book({ at: slot(1, '09:20') })).status).toBe(201);
    const sur = seedId('de000000', 2);
    expect((await post('', { patientId: kavita, doctorId: surgeonId, departmentId: sur, at: slot(1, '09:35') })).status).toBe(201);
  });

  it('422 for a past time, a doctor outside the department, a non-doctor or an unknown patient', async () => {
    for (const body of [
      { at: slot(-1, '09:00') },
      { at: slot(2, '09:00'), departmentId: seedId('de000000', 2) },
      { at: slot(2, '09:00'), doctorId: seedId('a0000000', 5) },
      { at: slot(2, '09:00'), patientId: seedId('9a710000', 999) },
      { at: slot(2, '09:00'), durationMin: 1 },
      { at: '2030-01-01 10:00' },
    ]) expect((await book(body)).status, JSON.stringify(body)).toBe(422);
    expect((await post('', { patientId: kavita, doctorId, departmentId: med, at: slot(2, '09:00') }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('PATCH /staff/appointments/{id}', () => {
  it('moves an appointment to a free slot, changes its length and note, keeping the old version', async () => {
    const id = await bookOne(slot(3, '10:00'));
    const res = await patch(id, { version: 1, at: slot(3, '12:00'), durationMin: 15, note: 'fasting sample' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 2, at: slot(3, '12:00'), durationMin: 15, note: 'fasting sample' });
    // The old slot is free again; the moved one is not.
    expect(await bookOne(slot(3, '10:00'))).toBeTruthy();
    expect((await post('', { patientId: kavita, doctorId, departmentId: med, at: slot(3, '12:10') })).status).toBe(409);
    expect((await patch(id, { version: 2, note: null })).status).toBe(200);
    expect((await db.query('SELECT version FROM appointments_versions WHERE record_id = $1 ORDER BY version', [id])).rows).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('409 for a taken slot, a stale version or an appointment no longer booked', async () => {
    const a = await bookOne(slot(4, '10:00'));
    const b = await bookOne(slot(4, '10:30'));
    expect((await patch(b, { version: 1, at: slot(4, '10:05') })).status).toBe(409);
    expect((await patch(b, { version: 1, durationMin: 10 })).status).toBe(200);
    expect((await patch(b, { version: 1, durationMin: 10 })).status).toBe(409);
    await db.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [a]);
    const res = await patch(a, { version: 1, note: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_booked' });
  });

  it('422 for a doctor outside the department or a past time; 404 for no such appointment', async () => {
    const id = await bookOne(slot(5, '10:00'));
    expect((await patch(id, { version: 1, doctorId: surgeonId })).status).toBe(422);
    expect((await patch(id, { version: 1, at: slot(-1, '10:00') })).status).toBe(422);
    expect((await patch(id, { at: slot(6, '10:00') })).status).toBe(422);
    expect((await patch(seedId('a9900000', 999), { version: 1, note: 'x' })).status).toBe(404);
  });
});

describe('POST /staff/appointments/{id}/check-in', () => {
  const ramesh = seedId('9a710000', 1);
  const rameshToday = seedId('a9900000', 1);

  it("marks today's appointment arrived and opens its OPD encounter", async () => {
    const before = Date.now();
    const res = await post(`/${rameshToday}/check-in`, {});
    expect(res.status).toBe(200);
    const { appointment, encounter } = (await res.json()) as { appointment: Record<string, unknown>; encounter: Record<string, unknown> };
    expect(appointment).toMatchObject({ id: rameshToday, status: 'arrived', version: 2 });
    expect(encounter).toMatchObject({ status: 'open', type: 'OPD', patientId: ramesh, doctorId, departmentId: med, appointmentId: rameshToday });
    const activity = await db.query('SELECT last_activity_at, version FROM patients WHERE id = $1', [ramesh]);
    expect((activity.rows[0]?.last_activity_at as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(activity.rows[0]?.version).toBe(1);

    const timeline = await app.request(`/staff/patients/${ramesh}/timeline`, {}, asStaff('dev-doctor', ['doctor']));
    expect(((await timeline.json()) as { items: { kind: string; title: string }[] }).items).toMatchObject([
      { kind: 'encounter', title: 'OPD visit: General Medicine' },
    ]);
  });

  it('409 for an appointment already in, cancelled, or not for today; 404 for none', async () => {
    expect((await post(`/${rameshToday}/check-in`, {})).status).toBe(409);
    const later = await bookOne(slot(7, '10:00'));
    expect(await (await post(`/${later}/check-in`, {})).json()).toMatchObject({ error: 'not_today' });
    expect((await post(`/${seedId('a9900000', 999)}/check-in`, {})).status).toBe(404);
    expect((await db.query('SELECT count(*)::int AS n FROM encounters')).rows[0]).toEqual({ n: 1 });
  });
});

describe('POST /staff/appointments/{id}/cancel', () => {
  it('cancels a booked appointment with a reason and frees its slot', async () => {
    const id = await bookOne(slot(8, '10:00'));
    const res = await post(`/${id}/cancel`, { reason: 'patient called, travelling' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled', version: 2, voidedBy: 'dev-reception', voidReason: 'patient called, travelling' });
    expect(await bookOne(slot(8, '10:00'))).toBeTruthy();
    const versions = await db.query('SELECT reason FROM appointments_versions WHERE record_id = $1', [id]);
    expect(versions.rows).toEqual([{ reason: 'patient called, travelling' }]);
  });

  it('409 once cancelled or checked in; 422 without a reason; 403 for a nurse', async () => {
    const id = await bookOne(slot(9, '10:00'));
    expect((await post(`/${id}/cancel`, {})).status).toBe(422);
    expect((await post(`/${id}/cancel`, { reason: 'no' })).status).toBe(422);
    expect((await post(`/${id}/cancel`, { reason: 'duplicate booking' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await post(`/${id}/cancel`, { reason: 'duplicate booking' })).status).toBe(200);
    expect(await (await post(`/${id}/cancel`, { reason: 'duplicate booking' })).json()).toMatchObject({ error: 'not_booked' });
    expect((await post(`/${seedId('a9900000', 1)}/cancel`, { reason: 'duplicate booking' })).status).toBe(409);
  });
});
