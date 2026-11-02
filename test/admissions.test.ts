import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

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
