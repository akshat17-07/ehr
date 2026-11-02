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
const nurse = asStaff('dev-nurse', ['nurse']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const irfan = seedId('9a710000', 3);
const kavita = seedId('9a710000', 4);
const med = seedId('de000000', 1);
const doctorId = seedId('a0000000', 3);

const admit = (body: Record<string, unknown>, who = doctor) =>
  app.request('/staff/admissions', json({ departmentId: med, doctorId, ward: 'General Ward A', ...body }), who);

describe('POST /staff/admissions', () => {
  it('admits to a bed and opens the IPD encounter', async () => {
    const res = await admit({ patientId: irfan, bed: '1', reason: 'Dengue with low platelets' });
    expect(res.status).toBe(201);
    const admission = (await res.json()) as { encounterId: string };
    expect(admission).toMatchObject({ patientId: irfan, ward: 'General Ward A', bed: '1', status: 'current', doctorId, departmentId: med });
    const encounter = await app.request(`/staff/encounters/${admission.encounterId}`, {}, doctor);
    expect(await encounter.json()).toMatchObject({ type: 'IPD', status: 'open', patientId: irfan });
    const timeline = await app.request(`/staff/patients/${irfan}/timeline?kind=admission`, {}, doctor);
    expect(((await timeline.json()) as { items: { title: string }[] }).items.map((i) => i.title)).toEqual(['Admitted: General Ward A, bed 1']);
  });

  it('409 if already admitted or the bed is taken (ward case ignored)', async () => {
    expect(await (await admit({ patientId: irfan, bed: '9' })).json()).toMatchObject({ error: 'already_admitted' });
    expect(await (await admit({ patientId: kavita, bed: '1', ward: 'general ward a' })).json()).toMatchObject({ error: 'bed_taken' });
    expect((await admit({ patientId: kavita, bed: '2' })).status).toBe(201);
  });

  it('422 for an unknown patient, a doctor outside the department or a bad body; 403 for a nurse', async () => {
    expect((await admit({ patientId: seedId('9a710000', 999), bed: '3' })).status).toBe(422);
    expect((await admit({ patientId: seedId('9a710000', 5), bed: '3', doctorId: seedId('a0000000', 4) })).status).toBe(422);
    expect((await admit({ patientId: seedId('9a710000', 5), bed: '' })).status).toBe(422);
    expect((await admit({ patientId: seedId('9a710000', 5), bed: '3' }, nurse)).status).toBe(403);
    expect((await db.query('SELECT count(*)::int AS n FROM encounters WHERE type = $1', ['IPD'])).rows[0]?.n).toBe(2);
  });
});

describe('GET /staff/admissions', () => {
  type Item = { bed: string; ward: string; patient: { uhid: string } };
  const list = async (query = '', who = doctor) => {
    const res = await app.request(`/staff/admissions${query}`, {}, who);
    return { status: res.status, body: (await res.json()) as { items: Item[]; nextCursor?: string } };
  };

  it('lists the patients in beds by ward and bed, with the patient; filters and pages', async () => {
    await admit({ patientId: seedId('9a710000', 5), bed: '1', ward: 'Children Ward', departmentId: med });
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((a) => `${a.ward} ${a.bed} ${a.patient.uhid}`)).toEqual([
      'Children Ward 1 U26000005', 'General Ward A 1 U25000003', 'General Ward A 2 U25000004',
    ]);
    expect((await list('?ward=general%20ward%20a')).body.items).toHaveLength(2);
    expect((await list(`?doctorId=${seedId('a0000000', 4)}`)).body.items).toEqual([]);
    expect((await list('?current=false')).body.items.map((a) => a.patient.uhid)).toEqual(['U26000005', 'U25000004', 'U25000003']);
    const first = await list('?limit=2');
    expect((await list(`?limit=2&cursor=${first.body.nextCursor}`)).body.items.map((a) => a.bed)).toEqual(['2']);
  });

  it('422 for a bad filter; 403 for reception', async () => {
    expect((await list('?current=yes')).status).toBe(422);
    expect((await list('', asStaff('dev-reception', ['staff']))).status).toBe(403);
  });
});

describe('POST /staff/admissions/{id}/transfer', () => {
  const current = async (patientId: string) =>
    (await db.query('SELECT id, version FROM admissions WHERE current_patient = $1', [patientId])).rows[0] as { id: string; version: number };
  const move = (id: string, body: unknown, who = doctor) => app.request(`/staff/admissions/${id}/transfer`, json(body), who);

  it('moves to a free bed; the old bed is free again; the old one is in the history', async () => {
    const { id, version } = await current(irfan);
    const res = await move(id, { version, ward: 'ICU', bed: '4', reason: 'platelets under 20,000' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ward: 'ICU', bed: '4', version: version + 1, status: 'current' });
    const history = await db.query('SELECT data, reason FROM admissions_versions WHERE record_id = $1', [id]);
    expect(history.rows[0]).toMatchObject({ reason: 'platelets under 20,000' });
    expect(JSON.parse(String(history.rows[0]?.data))).toMatchObject({ ward: 'General Ward A', bed: '1' });
    expect((await admit({ patientId: seedId('9a710000', 1), bed: '1' })).status).toBe(201);
  });

  it('409 for a taken bed or a stale version; 422 for the same bed; 404 for none; 403 for a nurse', async () => {
    const { id, version } = await current(kavita);
    expect(await (await move(id, { version, ward: 'icu', bed: '4' })).json()).toMatchObject({ error: 'bed_taken' });
    expect((await move(id, { version: version + 5, ward: 'ICU', bed: '5' })).status).toBe(409);
    expect((await move(id, { version, ward: 'General Ward A', bed: '2' })).status).toBe(422);
    expect((await move(seedId('ad000000', 999), { version: 1, ward: 'ICU', bed: '5' })).status).toBe(404);
    expect((await move(id, { version, ward: 'ICU', bed: '5' }, nurse)).status).toBe(403);
  });
});

describe('GET /staff/admissions/{id}/mar', () => {
  const admissionOf = async (patientId: string) =>
    (await db.query('SELECT id, encounter_id FROM admissions WHERE current_patient = $1', [patientId])).rows[0] as { id: string; encounter_id: string };
  const mar = (id: string, query = '', who = doctor) => app.request(`/staff/admissions/${id}/mar${query}`, {}, who);

  it("lists the stay's confirmed prescription lines as the schedule; no entries yet", async () => {
    const { id, encounter_id } = await admissionOf(irfan);
    const lines = [
      { drugId: seedId('d0000000', 9), drugText: 'Ceftriaxone 1 g', dose: '1 g IV', frequency: 'twice a day', days: 5 },
      { drugText: 'Paracetamol 500 mg', dose: '1 tablet', frequency: 'when fever over 100 F', days: 3 },
    ];
    expect((await app.request(`/staff/encounters/${encounter_id}/prescriptions`, json({ lines, acknowledgedAlerts: [] }), doctor)).status).toBe(201);
    const res = await mar(id, '', nurse);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedule: { lineIndex: number; drugText: string; frequency: string }[]; entries: unknown[] };
    expect(body.schedule).toMatchObject([
      { lineIndex: 0, drugText: 'Ceftriaxone 1 g', dose: '1 g IV', frequency: 'twice a day' },
      { lineIndex: 1, drugText: 'Paracetamol 500 mg' },
    ]);
    expect(body.entries).toEqual([]);
  });

  it('422 for a bad date; 404 for none; 403 for a GP', async () => {
    const { id } = await admissionOf(irfan);
    expect((await mar(id, '?date=yesterday')).status).toBe(422);
    expect((await mar(seedId('ad000000', 999))).status).toBe(404);
    expect((await mar(id, '', asStaff('dev-gp', ['gp']))).status).toBe(403);
  });
});

describe('POST /staff/admissions/{id}/mar', () => {
  const stay = async () => {
    const { id } = (await db.query('SELECT id FROM admissions WHERE current_patient = $1', [irfan])).rows[0] as { id: string };
    const rx = (await db.query("SELECT p.id FROM prescriptions p JOIN admissions a ON a.encounter_id = p.encounter_id WHERE a.id = $1", [id])).rows[0];
    return { id, prescriptionId: String(rx?.id) };
  };
  const record = (id: string, body: unknown, who = nurse) => app.request(`/staff/admissions/${id}/mar`, json(body), who);

  it('records doses given and held; they show on the day', async () => {
    const { id, prescriptionId } = await stay();
    const given = await record(id, { prescriptionId, lineIndex: 0, outcome: 'given', dose: '1 g IV' });
    expect(given.status).toBe(201);
    expect(await given.json()).toMatchObject({ admissionId: id, prescriptionId, lineIndex: 0, outcome: 'given', dose: '1 g IV', createdBy: 'dev-nurse' });
    expect((await record(id, { prescriptionId, lineIndex: 1, outcome: 'held', note: 'no fever, 98.6 F', at: new Date(Date.now() + 1000).toISOString() })).status).toBe(201);
    const day = (await (await app.request(`/staff/admissions/${id}/mar`, {}, nurse)).json()) as { entries: { outcome: string }[] };
    expect(day.entries.map((e) => e.outcome)).toEqual(['given', 'held']);
    expect((await (await app.request(`/staff/admissions/${id}/mar?date=2020-01-01`, {}, nurse)).json()) as { entries: unknown[] }).toMatchObject({ entries: [] });
  });

  it('422 for held without a note, a line not on the schedule, a future time or before admission; 403 for reception', async () => {
    const { id, prescriptionId } = await stay();
    expect((await record(id, { prescriptionId, lineIndex: 1, outcome: 'refused' })).status).toBe(422);
    expect((await record(id, { prescriptionId, lineIndex: 2, outcome: 'given' })).status).toBe(422);
    expect((await record(id, { prescriptionId: seedId('9c000000', 1), lineIndex: 0, outcome: 'given' })).status).toBe(422);
    expect((await record(id, { prescriptionId, lineIndex: 0, outcome: 'given', at: '2999-01-01T00:00:00Z' })).status).toBe(422);
    expect((await record(id, { prescriptionId, lineIndex: 0, outcome: 'given', at: '2020-01-01T00:00:00Z' })).status).toBe(422);
    expect((await record(id, { prescriptionId, lineIndex: 0, outcome: 'given' }, asStaff('dev-reception', ['staff']))).status).toBe(403);
    expect((await record(seedId('ad000000', 999), { prescriptionId, lineIndex: 0, outcome: 'given' })).status).toBe(404);
  });
});

describe('POST /staff/encounters/{id}/discharge-summary', () => {
  const encounterOf = async (patientId: string) =>
    String((await db.query('SELECT encounter_id FROM admissions WHERE current_patient = $1', [patientId])).rows[0]?.encounter_id);
  const summary = {
    diagnosisText: 'Dengue fever with thrombocytopenia (A90)',
    course: 'IV fluids, platelets monitored daily; rose to 1.2 lakh by day 5.',
    medicinesOnDischarge: [{ drugText: 'Paracetamol 500 mg', dose: '1 tablet', frequency: 'when fever', days: 3 }],
    advice: 'Plenty of fluids. Come back if bleeding or fever returns.',
    followUpDate: indiaDate(new Date(Date.now() + 7 * 86_400_000)),
  };
  const write = (encounterId: string, body: unknown, who = doctor) => app.request(`/staff/encounters/${encounterId}/discharge-summary`, json(body), who);

  it('writes a draft summary on the IPD encounter; 409 for a second one', async () => {
    const encounterId = await encounterOf(irfan);
    const res = await write(encounterId, summary);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ encounterId, patientId: irfan, status: 'draft', followUpDate: summary.followUpDate, medicinesOnDischarge: [{ days: 3 }] });
    expect(await (await write(encounterId, summary)).json()).toMatchObject({ error: 'already_written' });
  });

  it('422 for an OPD encounter, a past follow-up or a bad body; 403 for a nurse; 404 for none', async () => {
    const opd = await app.request('/staff/encounters', json({ patientId: kavita, type: 'OPD', departmentId: med, doctorId }), doctor);
    expect((await write(((await opd.json()) as { id: string }).id, summary)).status).toBe(422);
    const encounterId = await encounterOf(kavita);
    expect((await write(encounterId, { ...summary, followUpDate: '2020-01-01' })).status).toBe(422);
    expect((await write(encounterId, { ...summary, advice: '' })).status).toBe(422);
    expect((await write(encounterId, summary, nurse)).status).toBe(403);
    expect((await write(seedId('e0000000', 999), summary)).status).toBe(404);
  });
});

describe('PATCH /staff/discharge-summaries/{id}', () => {
  const summaryOf = async () => (await db.query('SELECT id, version FROM discharge_summaries LIMIT 1')).rows[0] as { id: string; version: number };
  const patch = (id: string, body: unknown, who = doctor) =>
    app.request(`/staff/discharge-summaries/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('changes the draft; the old text is in the history', async () => {
    const { id, version } = await summaryOf();
    const res = await patch(id, { version, advice: 'Fluids, rest for a week. Come back if bleeding.', medicinesOnDischarge: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: version + 1, advice: 'Fluids, rest for a week. Come back if bleeding.', medicinesOnDischarge: [], status: 'draft' });
    const history = await db.query('SELECT data FROM discharge_summaries_versions WHERE record_id = $1', [id]);
    expect(JSON.parse(String(history.rows[0]?.data))).toMatchObject({ advice: 'Plenty of fluids. Come back if bleeding or fever returns.' });
  });

  it('409 for a stale version; 422 for nothing to change or a past follow-up; 403 for a nurse; 404 for none', async () => {
    const { id, version } = await summaryOf();
    expect((await patch(id, { version: version + 3, course: 'x' })).status).toBe(409);
    expect((await patch(id, { version })).status).toBe(422);
    expect((await patch(id, { version, followUpDate: '2020-01-01' })).status).toBe(422);
    expect((await patch(id, { version, course: 'x' }, nurse)).status).toBe(403);
    expect((await patch(seedId('d5000000', 999), { version: 1, course: 'x' })).status).toBe(404);
  });
});

describe('POST /staff/discharge-summaries/{id}/sign', () => {
  const sign = (id: string, body: unknown, who = doctor) => app.request(`/staff/discharge-summaries/${id}/sign`, json(body), who);
  const summaryFor = async (patientId: string) =>
    (await db.query('SELECT id, version, encounter_id FROM discharge_summaries WHERE patient_id = $1', [patientId])).rows[0] as {
      id: string; version: number; encounter_id: string;
    };

  it('signs, discharges the patient, frees the bed and closes the encounter', async () => {
    const { id, version, encounter_id } = await summaryFor(irfan);
    expect((await sign(id, { version }, nurse)).status).toBe(403);
    const res = await sign(id, { version });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'signed', signedBy: 'dev-doctor', signedAt: expect.any(String), version: version + 1 });
    const admission = (await db.query('SELECT * FROM admissions WHERE encounter_id = $1', [encounter_id])).rows[0];
    expect(admission).toMatchObject({ status: 'discharged', bed_key: null, current_patient: null });
    expect(admission?.discharged_at).toBeInstanceOf(Date);
    expect(await (await app.request(`/staff/encounters/${encounter_id}`, {}, doctor)).json()).toMatchObject({ status: 'closed' });
    expect((await admit({ patientId: seedId('9a710000', 2), bed: '4', ward: 'ICU' })).status).toBe(201);
    expect(await (await sign(id, { version: version + 1 })).json()).toMatchObject({ error: 'signed' });
    const patch = await app.request(`/staff/discharge-summaries/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: version + 1, course: 'x' }) }, doctor);
    expect(await patch.json()).toMatchObject({ error: 'signed' });
  });

  it('409 draft_notes with an unsigned note, and nothing changes; 409 for a stale version', async () => {
    const encounterId = String((await db.query('SELECT encounter_id FROM admissions WHERE current_patient = $1', [kavita])).rows[0]?.encounter_id);
    const written = await app.request(`/staff/encounters/${encounterId}/discharge-summary`, json({ diagnosisText: 'Viral fever', course: 'Settled.', medicinesOnDischarge: [], advice: 'Rest.' }), doctor);
    const { id, version } = (await written.json()) as { id: string; version: number };
    expect((await app.request(`/staff/encounters/${encounterId}/notes`, json({ kind: 'progress', text: 'Afebrile today.' }), doctor)).status).toBe(201);
    expect(await (await sign(id, { version })).json()).toMatchObject({ error: 'draft_notes' });
    expect((await summaryFor(kavita))).toMatchObject({ version });
    expect((await db.query('SELECT status FROM admissions WHERE encounter_id = $1', [encounterId])).rows[0]).toMatchObject({ status: 'current' });
    expect((await sign(id, { version: version + 2 })).status).toBe(409);
    expect((await sign(seedId('d5000000', 999), { version: 1 })).status).toBe(404);
  });
});
