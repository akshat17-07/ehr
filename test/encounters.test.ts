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

describe('POST /staff/encounters/{id}/close', () => {
  const close = (id: string, who = doctor) => app.request(`/staff/encounters/${id}/close`, { method: 'POST' }, who);

  it('closes an open encounter once; then it lists as closed', async () => {
    const id = await open(seedId('9a710000', 2));
    const res = await close(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; closedAt: string; version: number };
    expect(body).toMatchObject({ status: 'closed', version: 2 });
    expect(Date.parse(body.closedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(await (await close(id)).json()).toMatchObject({ error: 'closed' });
    expect((await list('?status=closed')).body.items.map((e) => e.patientId)).toContain(seedId('9a710000', 2));
  });

  it('404 for none; 403 without encounter.update', async () => {
    expect((await close(seedId('e0c00000', 999))).status).toBe(404);
    expect((await close(await open(seedId('9a710000', 2)), reception)).status).toBe(403);
  });
});

describe('POST /staff/encounters/{id}/vitals', () => {
  const nurse = asStaff('dev-nurse', ['nurse']);
  const vitals = (id: string, body: unknown, who = nurse) =>
    app.request(`/staff/encounters/${id}/vitals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('records a set of readings; the encounter shows them', async () => {
    const id = await open(seedId('9a710000', 2));
    const res = await vitals(id, { bpSys: 132, bpDia: 86, pulse: 78, tempC: 37.2, spo2: 98, weightKg: 61.5 });
    expect(res.status).toBe(201);
    const vital = (await res.json()) as Record<string, unknown>;
    expect(vital).toMatchObject({ encounterId: id, patientId: seedId('9a710000', 2), bpSys: 132, bpDia: 86, tempC: 37.2, weightKg: 61.5, createdBy: 'dev-nurse' });
    expect(vital).not.toHaveProperty('heightCm');
    expect((await vitals(id, { bloodSugarMgDl: 140, takenAt: new Date(Date.now() - 600_000).toISOString() })).status).toBe(201);
    const detail = (await (await app.request(`/staff/encounters/${id}`, {}, doctor)).json()) as { vitals: Record<string, unknown>[] };
    expect(detail.vitals.map((v) => v.bloodSugarMgDl ?? v.bpSys)).toEqual([140, 132]);
  });

  it('422 for no readings, a reading out of range, half a BP or a future time; 409 once closed; 403 for reception', async () => {
    const id = await open(seedId('9a710000', 2));
    for (const body of [{}, { pulse: 900 }, { bpSys: 120 }, { bpSys: 80, bpDia: 90 }, { spo2: '98' }, { pulse: 70, takenAt: '2099-01-01T00:00:00Z' }, { pulse: 70, mood: 'ok' }]) {
      expect((await vitals(id, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await vitals(id, { pulse: 70 }, reception)).status).toBe(403);
    await app.request(`/staff/encounters/${id}/close`, { method: 'POST' }, doctor);
    expect((await vitals(id, { pulse: 70 })).status).toBe(409);
  });
});

describe('GET /staff/patients/{id}/vitals', () => {
  const irfan = seedId('9a710000', 3);
  const history = (query = '', who = doctor) => app.request(`/staff/patients/${irfan}/vitals${query}`, {}, who);

  it("lists the patient's vitals across encounters, newest first, by date range and page", async () => {
    const insert = (n: number, at: string, pulse: number) =>
      db.query(
        "INSERT INTO vitals (id, status, created_by, updated_by, encounter_id, patient_id, taken_at, pulse) VALUES ($1, 'active', 'x', 'x', $2, $3, $4, $5)",
        [seedId('717a0000', n), seedId('e0c00000', 50), irfan, at, pulse],
      );
    await insert(1, '2026-03-01T05:00:00Z', 70);
    await insert(2, '2026-04-01T05:00:00Z', 80);
    await insert(3, '2026-05-01T05:00:00Z', 90);
    await db.query('UPDATE vitals SET voided_at = now() WHERE id = $1', [seedId('717a0000', 3)]);

    const all = (await (await history()).json()) as { items: { pulse: number }[] };
    expect(all.items.map((v) => v.pulse)).toEqual([80, 70]);
    const march = (await (await history('?from=2026-03-01&to=2026-03-31')).json()) as { items: { pulse: number }[] };
    expect(march.items.map((v) => v.pulse)).toEqual([70]);
    const first = (await (await history('?limit=1')).json()) as { items: { pulse: number }[]; nextCursor: string };
    const next = (await (await history(`?limit=1&cursor=${first.nextCursor}`)).json()) as { items: { pulse: number }[] };
    expect(next.items.map((v) => v.pulse)).toEqual([70]);
  });

  it('422 for a bad date; 404 for no such patient; 403 for a GP', async () => {
    expect((await history('?from=yesterday')).status).toBe(422);
    expect((await app.request(`/staff/patients/${seedId('9a710000', 999)}/vitals`, {}, doctor)).status).toBe(404);
    expect((await history('', asStaff('dev-gp', ['gp']))).status).toBe(403);
  });
});

describe('POST /staff/encounters/{id}/observations', () => {
  const nurse = asStaff('dev-nurse', ['nurse']);
  const observe = (id: string, body: unknown, who = nurse) =>
    app.request(`/staff/encounters/${id}/observations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('records a coded number or text', async () => {
    const id = await open(seedId('9a710000', 2));
    const res = await observe(id, { loinc: '8867-4', name: 'Heart rate (manual)', value: 88, unit: '/min' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ encounterId: id, loinc: '8867-4', value: 88, unit: '/min', createdBy: 'dev-nurse' });
    const text = await observe(id, { loinc: '8310-5', name: 'Temperature', value: 'afebrile to touch' });
    expect(await text.json()).toMatchObject({ value: 'afebrile to touch' });
  });

  it('422 for a code not in the list, a bad code or value; 409 once closed; 403 for reception', async () => {
    const id = await open(seedId('9a710000', 2));
    for (const body of [
      { loinc: '99999-9', name: 'x', value: 1 },
      { loinc: 'HR', name: 'x', value: 1 },
      { loinc: '8867-4', name: 'x', value: true },
      { loinc: '8867-4', name: 'x', value: '' },
      { loinc: '8867-4', value: 1 },
    ]) expect((await observe(id, body)).status, JSON.stringify(body)).toBe(422);
    expect((await observe(id, { loinc: '8867-4', name: 'x', value: 1 }, reception)).status).toBe(403);
    await app.request(`/staff/encounters/${id}/close`, { method: 'POST' }, doctor);
    expect((await observe(id, { loinc: '8867-4', name: 'x', value: 1 })).status).toBe(409);
  });
});

describe('GET /staff/patients/{id}/observations', () => {
  const kavita = seedId('9a710000', 4);
  const history = (query = '', who = doctor) => app.request(`/staff/patients/${kavita}/observations${query}`, {}, who);

  it('lists newest first, one measure with loinc, by date range', async () => {
    const insert = (n: number, loinc: string, at: string, value: number) =>
      db.query(
        "INSERT INTO observations (id, status, created_by, updated_by, encounter_id, patient_id, loinc, name, value_num, taken_at) VALUES ($1, 'active', 'x', 'x', $2, $3, $4, 'x', $5, $6)",
        [seedId('0b5e0000', n), seedId('e0c00000', 60), kavita, loinc, value, at],
      );
    await insert(1, '8867-4', '2026-03-01T05:00:00Z', 70);
    await insert(2, '9279-1', '2026-04-01T05:00:00Z', 18);
    await insert(3, '8867-4', '2026-05-01T05:00:00Z', 90);
    type Body = { items: { value: number }[] };
    expect(((await (await history()).json()) as Body).items.map((o) => o.value)).toEqual([90, 18, 70]);
    expect(((await (await history('?loinc=8867-4')).json()) as Body).items.map((o) => o.value)).toEqual([90, 70]);
    expect(((await (await history('?from=2026-04-01&to=2026-04-30')).json()) as Body).items.map((o) => o.value)).toEqual([18]);
  });

  it('422 for a bad date; 403 for a GP', async () => {
    expect((await history('?to=soon')).status).toBe(422);
    expect((await history('', asStaff('dev-gp', ['gp']))).status).toBe(403);
  });
});

describe('POST /staff/encounters/{id}/notes', () => {
  const note = (id: string, body: unknown, who = doctor) =>
    app.request(`/staff/encounters/${id}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('adds a draft note; the encounter shows it, the timeline lists it, and it keeps the encounter open', async () => {
    const sita = seedId('9a710000', 2);
    const id = await open(sita);
    const res = await note(id, { kind: 'progress', text: 'Fever 3 days. Advised CBC.' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'draft', kind: 'progress', encounterId: id, patientId: sita, addenda: [] });
    const detail = (await (await app.request(`/staff/encounters/${id}`, {}, doctor)).json()) as { notes: { text: string }[] };
    expect(detail.notes.map((n) => n.text)).toEqual(['Fever 3 days. Advised CBC.']);
    const timeline = (await (await app.request(`/staff/patients/${sita}/timeline?kind=note`, {}, doctor)).json()) as { items: { title: string }[] };
    expect(timeline.items.map((i) => i.title)).toContain('Progress note');
    const close = await app.request(`/staff/encounters/${id}/close`, { method: 'POST' }, doctor);
    expect(await close.json()).toMatchObject({ error: 'draft_notes' });
  });

  it('422 for a nursing or unknown kind or empty text; 409 once closed; 403 for a nurse', async () => {
    const id = await open(seedId('9a710000', 2));
    for (const body of [{ kind: 'nursing', text: 'x' }, { kind: 'memo', text: 'x' }, { kind: 'progress', text: '  ' }, { kind: 'progress' }]) {
      expect((await note(id, body)).status, JSON.stringify(body)).toBe(422);
    }
    expect((await note(id, { kind: 'progress', text: 'x' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    await app.request(`/staff/encounters/${id}/close`, { method: 'POST' }, doctor);
    expect((await note(id, { kind: 'progress', text: 'x' })).status).toBe(409);
  });
});
