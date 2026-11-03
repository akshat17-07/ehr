import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

// Patient-pool tokens: the sub links to a patient in patient_accounts.
const asPatient = (sub: string) => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, email: `${sub}@x.in` } } } } } }) as never;
const A = asPatient('pt-visits-ramesh');
const B = asPatient('pt-visits-kavita');

const ramesh = seedId('9a710000', 1);
const sita = seedId('9a710000', 2); // A's wife, with portal access through A
const kavita = seedId('9a710000', 4);
const doctorId = seedId('a0000000', 3);
const med = seedId('de000000', 1);
const AT = '2026-10-01T04:00:00Z';

const get = (path: string, who: never) => app.request(path, {}, who);
const generic403 = { error: 'forbidden', message: 'not a patient this account may see' };

// Fixtures: a closed visit with clinical rows of every state, and a voided visit.
const visit = randomUUID();
const voidedVisit = randomUUID();
const sitaVisit = randomUUID();
const signedNote = randomUUID();
const rxConfirmed = randomUUID();
const rxDispensed = randomUUID();
const rxDraft = randomUUID();
const rxVoid = randomUUID();
const rxVoidedRow = randomUUID();
const lines = [{ drugText: 'Paracetamol 500 mg tablet', dose: '1 tab', frequency: 'TDS', days: 5 }];

const row = (table: string, id: string, extra: Record<string, unknown>) => {
  const cols = { id, status: 'active', created_by: 'dev-doctor', updated_by: 'dev-doctor', created_at: AT, updated_at: AT, ...extra };
  const keys = Object.keys(cols);
  return db.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(cols));
};

beforeAll(async () => {
  await db.query(
    `INSERT INTO patient_accounts (id, status, created_at, created_by, updated_by, patient_id, cognito_sub)
     VALUES ($1, 'active', $2, 'system', 'system', $3, 'pt-visits-ramesh'), ($4, 'active', $2, 'system', 'system', $5, 'pt-visits-kavita')`,
    [randomUUID(), AT, ramesh, randomUUID(), kavita],
  );
  await db.query(
    `INSERT INTO guardians (id, status, created_at, created_by, updated_by, patient_id, guardian_patient_id, name, relation, portal_access)
     VALUES ($1, 'active', $2, 'system', 'system', $3, $4, 'Ramesh', 'Husband', true)`,
    [randomUUID(), AT, sita, ramesh],
  );
  const enc = (id: string, patientId: string, startedAt: string, voided = false) =>
    row('encounters', id, {
      patient_id: patientId, type: 'OPD', department_id: med, doctor_id: doctorId,
      status: 'closed', started_at: startedAt, closed_at: startedAt, created_at: startedAt, ...(voided && { voided_at: AT }),
    });
  await enc(visit, ramesh, '2026-10-02T04:00:00Z');
  await enc(voidedVisit, ramesh, '2026-10-03T04:00:00Z', true);
  await enc(randomUUID(), ramesh, '2026-09-01T04:00:00Z');
  await enc(sitaVisit, sita, '2026-10-04T04:00:00Z');
  await row('vitals', randomUUID(), { encounter_id: visit, patient_id: ramesh, taken_at: AT, bp_sys: 130, pulse: 82, spo2: 98 });
  await row('diagnoses', randomUUID(), { encounter_id: visit, patient_id: ramesh, icd10: 'J06.9', text: 'Acute upper respiratory infection', kind: 'final' });
  await row('diagnoses', randomUUID(), { encounter_id: visit, patient_id: ramesh, icd10: 'R50.9', text: 'Fever, provisional', kind: 'provisional' });
  await row('diagnoses', randomUUID(), { encounter_id: visit, patient_id: ramesh, icd10: 'Z00.0', text: 'Voided final', kind: 'final', voided_at: AT });
  await row('notes', signedNote, {
    status: 'signed', encounter_id: visit, patient_id: ramesh, kind: 'consult', text: 'Viral URTI, rest and fluids.',
    signed_at: AT, signed_by: 'dev-doctor', addenda: JSON.stringify([{ text: 'Review if fever persists', by: 'dev-doctor', at: AT }]),
  });
  await row('notes', randomUUID(), { status: 'draft', encounter_id: visit, patient_id: ramesh, kind: 'progress', text: 'Draft, not signed', addenda: '[]' });
  await row('notes', randomUUID(), {
    status: 'signed', encounter_id: visit, patient_id: ramesh, kind: 'nursing', text: 'Staff-only nursing note',
    signed_at: AT, signed_by: 'dev-nurse', addenda: '[]', shift: 'morning',
  });
  await row('notes', randomUUID(), { status: 'signed', encounter_id: visit, patient_id: ramesh, kind: 'progress', text: 'Voided signed note', signed_at: AT, signed_by: 'dev-doctor', addenda: '[]', voided_at: AT });
  const rx = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    row('prescriptions', id, {
      encounter_id: visit, patient_id: ramesh, doctor_id: doctorId, source: 'typed', lines: JSON.stringify(lines),
      acknowledged_alerts: JSON.stringify(['Interaction warning']), confirmed_at: AT, confirmed_by: 'dev-doctor', status, ...extra,
    });
  await rx(rxConfirmed, 'confirmed');
  await rx(rxDispensed, 'dispensed');
  await rx(rxDraft, 'draft');
  await rx(rxVoid, 'void');
  await rx(rxVoidedRow, 'confirmed', { voided_at: AT });
  await row('prescriptions', randomUUID(), {
    encounter_id: sitaVisit, patient_id: sita, doctor_id: doctorId, source: 'typed', lines: '[]', status: 'confirmed', confirmed_at: AT,
  });
});

describe('GET /patient/visits', () => {
  it("lists the account's visits, newest first, without voided ones; a linked family member by patientId", async () => {
    const res = await get('/patient/visits', A);
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: Record<string, unknown>[] };
    expect(page.items.map((v) => v.startedAt)).toEqual(['2026-10-02T04:00:00.000Z', '2026-09-01T04:00:00.000Z']);
    expect(page.items[0]).toMatchObject({ id: visit, patientId: ramesh, type: 'OPD', departmentId: med, doctorId, status: 'closed' });
    expect(page.items[0]).not.toHaveProperty('createdBy');
    expect(page.items.some((v) => v.id === voidedVisit)).toBe(false);
    const family = (await (await get(`/patient/visits?patientId=${sita}`, A)).json()) as { items: { patientId: string }[] };
    expect(family.items).toEqual([expect.objectContaining({ patientId: sita })]);
  });

  it('pages with limit and cursor; 403 for another patient, an unknown or bad patientId', async () => {
    const first = (await (await get('/patient/visits?limit=1', A)).json()) as { items: unknown[]; nextCursor?: string };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = (await (await get(`/patient/visits?limit=1&cursor=${first.nextCursor}`, A)).json()) as { items: unknown[] };
    expect(second.items).toHaveLength(1);
    const other = await get(`/patient/visits?patientId=${kavita}`, A);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual(generic403);
    expect((await get(`/patient/visits?patientId=${seedId('9a710000', 999)}`, A)).status).toBe(403);
    expect((await get('/patient/visits?patientId=nope', A)).status).toBe(403);
  });
});

describe('GET /patient/visits/{id}', () => {
  it('gives vitals, final diagnoses, signed non-nursing notes and issued prescriptions, without staff-only fields', async () => {
    const res = await get(`/patient/visits/${visit}`, A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: visit,
      patientId: ramesh,
      vitals: [{ bpSys: 130, pulse: 82, spo2: 98, takenAt: '2026-10-01T04:00:00.000Z' }],
      diagnoses: [{ icd10: 'J06.9', text: 'Acute upper respiratory infection' }],
      notes: [{ id: signedNote, kind: 'consult', text: 'Viral URTI, rest and fluids.', addenda: [{ text: 'Review if fever persists', at: AT }] }],
      prescriptions: [
        expect.objectContaining({ id: rxConfirmed, status: 'confirmed', lines }),
        expect.objectContaining({ id: rxDispensed, status: 'dispensed' }),
      ],
    });
    expect(body.diagnoses).toHaveLength(1);
    expect(body.notes).toHaveLength(1);
    expect(body.prescriptions).toHaveLength(2);
    const text = JSON.stringify(body);
    for (const hidden of ['Staff-only', 'Draft, not signed', 'Voided signed', 'Fever, provisional', 'Voided final', 'Interaction warning', 'dev-doctor', 'dev-nurse', 'createdBy', 'acknowledgedAlerts', 'signedBy']) {
      expect(text).not.toContain(hidden);
    }
    expect(text).not.toContain(rxDraft);
    expect(text).not.toContain(rxVoid);
    expect(text).not.toContain(rxVoidedRow);
  });

  it("the same generic 403 for another patient's visit, a voided visit, an unknown or bad id", async () => {
    const other = await get(`/patient/visits/${visit}`, B);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual(generic403);
    expect((await get(`/patient/visits/${voidedVisit}`, A)).status).toBe(403);
    const unknown = await get(`/patient/visits/${randomUUID()}`, A);
    expect(await unknown.json()).toEqual(generic403);
    expect((await get('/patient/visits/nope', A)).status).toBe(403);
  });

  it('a linked family member visit opens for the account; a sensitive label hides the clinical parts', async () => {
    expect(await (await get(`/patient/visits/${sitaVisit}`, A)).json()).toMatchObject({ patientId: sita, prescriptions: [expect.anything()] });
    await db.query("UPDATE patients SET labels = '[\"hiv\"]' WHERE id = $1", [sita]);
    try {
      expect(await (await get(`/patient/visits/${sitaVisit}`, A)).json()).toMatchObject({ patientId: sita, vitals: [], diagnoses: [], notes: [], prescriptions: [] });
      expect(await (await get(`/patient/prescriptions?patientId=${sita}`, A)).json()).toEqual({ items: [] });
    } finally {
      await db.query("UPDATE patients SET labels = '[]' WHERE id = $1", [sita]);
    }
  });
});

describe('GET /patient/prescriptions', () => {
  it('lists the issued, non-voided prescriptions for the account and its family members', async () => {
    const page = (await (await get('/patient/prescriptions', A)).json()) as { items: { id: string; status: string }[] };
    expect(page.items.map((p) => p.id).sort()).toEqual([rxConfirmed, rxDispensed].sort());
    expect(page.items[0]).not.toHaveProperty('acknowledgedAlerts');
    expect(page.items[0]).not.toHaveProperty('confirmedBy');
    const family = (await (await get(`/patient/prescriptions?patientId=${sita}`, A)).json()) as { items: unknown[] };
    expect(family.items).toHaveLength(1);
    const paged = (await (await get('/patient/prescriptions?limit=1', A)).json()) as { items: unknown[]; nextCursor?: string };
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).toBeDefined();
  });

  it('the same generic 403 for another patient, an unknown or bad patientId', async () => {
    const other = await get(`/patient/prescriptions?patientId=${ramesh}`, B);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual(generic403);
    expect((await get(`/patient/prescriptions?patientId=${seedId('9a710000', 999)}`, B)).status).toBe(403);
    expect((await get('/patient/prescriptions?patientId=nope', A)).status).toBe(403);
  });
});
