import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// #245 /patient/documents, #246 /patient/documents/{id}/view-url, #250 /patient/surgeries.

env.FILES_BUCKET = 'files-test';
const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db, signUrl: async (bucket, key, seconds) => `https://s3.test/${bucket}/${key}?get=${seconds}` });

const asPatient = (sub: string) => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, email: `${sub}@x.in` } } } } } }) as never;
const A = asPatient('pt-docs-ramesh');
const B = asPatient('pt-docs-kavita');

const ramesh = seedId('9a710000', 1);
const sita = seedId('9a710000', 2); // A's wife, with portal access through A
const kavita = seedId('9a710000', 4);
const surgeonId = seedId('a0000000', 4);
const nurseId = seedId('a0000000', 5);
const doctorId = seedId('a0000000', 3);
const med = seedId('de000000', 1);
const AT = '2026-10-01T04:00:00Z';

const get = (path: string, who: never) => app.request(path, {}, who);
const generic403 = { error: 'forbidden', message: 'not a patient this account may see' };

const row = (table: string, id: string, extra: Record<string, unknown>) => {
  const cols = { id, status: 'active', created_by: 'dev-reception', updated_by: 'dev-reception', created_at: AT, updated_at: AT, ...extra };
  const keys = Object.keys(cols);
  return db.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(cols));
};

let n = 0;
const doc = async (patientId: string, type: string, extra: Record<string, unknown> = {}) => {
  const id = randomUUID();
  n += 1;
  const at = new Date(Date.parse(AT) + n * 60_000).toISOString();
  await row('documents', id, {
    status: 'ready', patient_id: patientId, type, file_name: `${type}-${n}.pdf`, mime: 'application/pdf', size_bytes: 1000 + n,
    sha256: n.toString(16).padStart(64, '0'), s3_key: `patients/${patientId}/${id}`, uploaded_at: at, created_at: at, ...extra,
  });
  return id;
};

// Ramesh's files
let lab: string, idProof: string, consent: string, pending: string, misfiled: string, voided: string, copy: string;
// Sita's files: one administrative, one clinical, one filed with a Form F
let sitaInsurance: string, sitaReport: string, sitaFormF: string, sitaConsent: string;
let kavitaDoc: string;
// Surgeries
const ownSurgery = randomUUID();
const partnerSurgery = randomUUID();
const cancelledSurgery = randomUUID();
const voidedSurgery = randomUUID();
const sitaSurgery = randomUUID();
const partnerId = randomUUID();

beforeAll(async () => {
  await db.query(
    `INSERT INTO patient_accounts (id, status, created_at, created_by, updated_by, patient_id, cognito_sub)
     VALUES ($1, 'active', $2, 'system', 'system', $3, 'pt-docs-ramesh'), ($4, 'active', $2, 'system', 'system', $5, 'pt-docs-kavita')`,
    [randomUUID(), AT, ramesh, randomUUID(), kavita],
  );
  await db.query(
    `INSERT INTO guardians (id, status, created_at, created_by, updated_by, patient_id, guardian_patient_id, name, relation, portal_access)
     VALUES ($1, 'active', $2, 'system', 'system', $3, $4, 'Ramesh', 'Husband', true)`,
    [randomUUID(), AT, sita, ramesh],
  );
  lab = await doc(ramesh, 'lab_report');
  idProof = await doc(ramesh, 'id_proof');
  consent = await doc(ramesh, 'consent');
  pending = await doc(ramesh, 'imaging', { status: 'pending', uploaded_at: null });
  misfiled = await doc(ramesh, 'prescription', { status: 'misfiled', voided_at: AT, voided_by: 'dev-reception', void_reason: 'wrong patient' });
  voided = await doc(ramesh, 'discharge', { voided_at: AT, voided_by: 'dev-reception', void_reason: 'test' });
  copy = await doc(ramesh, 'other', { linked_from: misfiled });
  sitaInsurance = await doc(sita, 'insurance');
  sitaReport = await doc(sita, 'lab_report');
  sitaFormF = await doc(sita, 'imaging');
  sitaConsent = await doc(sita, 'consent');
  kavitaDoc = await doc(kavita, 'lab_report');

  const enc = randomUUID();
  await row('encounters', enc, { patient_id: sita, type: 'OPD', department_id: med, doctor_id: doctorId, status: 'closed', started_at: AT, closed_at: AT });
  await row('form_f', randomUUID(), {
    encounter_id: enc, patient_id: sita, doctor_id: doctorId, indication: 'Dating scan', procedure: 'USG', declaration_signed: true, document_id: sitaFormF,
  });

  await db.query("UPDATE hospital SET name = 'Indore Care Hospital'");
  await row('partner_hospitals', partnerId, { name: 'Bhopal Partner Hospital' });
  const surgery = (id: string, patientId: string, scheduledAt: string, extra: Record<string, unknown> = {}) =>
    row('surgeries', id, {
      status: 'scheduled', patient_id: patientId, procedure: 'Laparoscopic cholecystectomy', site: 'abdomen', side: 'na', surgeon_id: surgeonId,
      team_ids: JSON.stringify([nurseId]), scheduled_at: scheduledAt, venue: 'own', charges_paise: 4_500_000,
      consent_document_ids: '[]', instructions: 'Nil by mouth after 10 pm', created_by: 'dev-surgeon', updated_by: 'dev-surgeon',
      checklist: JSON.stringify({ signIn: { secret: 'CHECKLIST-INTERNAL' } }), op_note: JSON.stringify({ findings: 'OPNOTE-INTERNAL' }), ...extra,
    });
  await surgery(ownSurgery, ramesh, '2026-11-20T04:00:00Z', { consent_document_ids: JSON.stringify([consent, voided]) });
  await surgery(partnerSurgery, ramesh, '2026-10-05T04:00:00Z', {
    status: 'done', venue: 'partner', partner_hospital_id: partnerId, charges_paise: 9_000_000, procedure: 'Total knee replacement', instructions: null,
  });
  await surgery(cancelledSurgery, ramesh, '2026-11-10T04:00:00Z', { status: 'cancelled' });
  await surgery(voidedSurgery, ramesh, '2026-11-11T04:00:00Z', { voided_at: AT, voided_by: 'dev-surgeon', void_reason: 'entered twice' });
  await surgery(sitaSurgery, sita, '2026-11-21T04:00:00Z', { consent_document_ids: JSON.stringify([sitaConsent]) });
  await row('venue_payments', randomUUID(), {
    surgery_id: partnerSurgery, partner_hospital_id: partnerId, amount_paise: 6_123_400, paid_on: '2026-10-06', mode: 'bank', reference: 'VENUE-REF-1',
  });
});

const withLabel = async (patientId: string, fn: () => Promise<void>) => {
  await db.query("UPDATE patients SET labels = '[\"mtp\"]' WHERE id = $1", [patientId]);
  try {
    await fn();
  } finally {
    await db.query("UPDATE patients SET labels = '[]' WHERE id = $1", [patientId]);
  }
};

type Page = { items: Record<string, unknown>[]; nextCursor?: string };

describe('GET /patient/documents', () => {
  it('lists ready, non-voided documents newest first, without staff-only fields', async () => {
    const res = await get('/patient/documents', A);
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    expect(page.items.map((d) => d.id)).toEqual([copy, consent, idProof, lab]);
    expect(page.items[3]).toEqual({
      id: lab, patientId: ramesh, type: 'lab_report', fileName: 'lab_report-1.pdf', mime: 'application/pdf', sizeBytes: 1001,
      createdAt: '2026-10-01T04:01:00.000Z', uploadedAt: '2026-10-01T04:01:00.000Z',
    });
    const text = JSON.stringify(page);
    for (const hidden of ['createdBy', 'updatedBy', 'dev-reception', 'sha256', 's3Key', 'patients/', 'linkedFrom', 'version', pending, misfiled, voided]) {
      expect(text).not.toContain(hidden);
    }
  });

  it('filters by type and pages with limit and cursor', async () => {
    const typed = (await (await get('/patient/documents?type=consent', A)).json()) as Page;
    expect(typed.items.map((d) => d.id)).toEqual([consent]);
    expect((await get('/patient/documents?type=xray', A)).status).toBe(422);
    const first = (await (await get('/patient/documents?limit=3', A)).json()) as Page;
    expect(first.items).toHaveLength(3);
    const second = (await (await get(`/patient/documents?limit=3&cursor=${first.nextCursor}`, A)).json()) as Page;
    expect(second.items.map((d) => d.id)).toEqual([lab]);
  });

  it('a linked family member by patientId; a file filed with a Form F is never shown', async () => {
    const page = (await (await get(`/patient/documents?patientId=${sita}`, A)).json()) as Page;
    expect(page.items.map((d) => d.id)).toEqual([sitaConsent, sitaReport, sitaInsurance]);
  });

  it('a sensitive label leaves only ID proof and insurance', async () => {
    await withLabel(sita, async () => {
      const page = (await (await get(`/patient/documents?patientId=${sita}`, A)).json()) as Page;
      expect(page.items.map((d) => d.id)).toEqual([sitaInsurance]);
      const clinical = (await (await get(`/patient/documents?patientId=${sita}&type=lab_report`, A)).json()) as Page;
      expect(clinical.items).toEqual([]);
    });
  });

  it('the same generic 403 for another patient, an unknown or a bad patientId', async () => {
    const other = await get(`/patient/documents?patientId=${kavita}`, A);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual(generic403);
    expect(await (await get(`/patient/documents?patientId=${ramesh}`, B)).json()).toEqual(generic403);
    expect((await get(`/patient/documents?patientId=${seedId('9a710000', 999)}`, A)).status).toBe(403);
    expect((await get('/patient/documents?patientId=nope', A)).status).toBe(403);
  });
});

describe('GET /patient/documents/{id}/view-url', () => {
  it('gives a 10-minute signed link for an own or family document, and audits the view', async () => {
    const res = await get(`/patient/documents/${lab}/view-url`, A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(body).toEqual({ url: `https://s3.test/files-test/patients/${ramesh}/${lab}?get=600`, expiresAt: expect.any(String) });
    const ms = Date.parse(body.expiresAt) - Date.now();
    expect(ms).toBeGreaterThan(9 * 60_000);
    expect(ms).toBeLessThanOrEqual(10 * 60_000);
    const { rows } = await db.query(
      "SELECT patient_id::text AS patient_id FROM audit_events WHERE record_type = 'document' AND record_id::text = $1",
      [lab],
    );
    expect(rows[0]).toMatchObject({ patient_id: ramesh });
    expect((await get(`/patient/documents/${sitaReport}/view-url`, A)).status).toBe(200);
  });

  it("the same generic 403 for another patient's, unknown, bad, pending, misfiled, voided or Form F documents", async () => {
    for (const id of [kavitaDoc, randomUUID(), 'nope', pending, misfiled, voided, sitaFormF]) {
      const res = await get(`/patient/documents/${id}/view-url`, A);
      expect(res.status, id).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    expect(await (await get(`/patient/documents/${lab}/view-url`, B)).json()).toEqual(generic403);
  });

  it("a sensitive label: clinical documents are the generic 403, ID proof and insurance still open", async () => {
    await withLabel(sita, async () => {
      for (const id of [sitaReport, sitaConsent]) expect(await (await get(`/patient/documents/${id}/view-url`, A)).json()).toEqual(generic403);
      expect((await get(`/patient/documents/${sitaInsurance}/view-url`, A)).status).toBe(200);
    });
  });
});

describe('GET /patient/surgeries', () => {
  it('lists non-cancelled, non-voided surgeries newest first with hospital, surgeon, instructions, estimate and consents', async () => {
    const res = await get('/patient/surgeries', A);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Record<string, unknown>[];
    expect(list.map((s) => s.id)).toEqual([ownSurgery, partnerSurgery]);
    expect(list[0]).toEqual({
      id: ownSurgery, status: 'scheduled', patientId: ramesh, procedure: 'Laparoscopic cholecystectomy', site: 'abdomen', side: 'na',
      scheduledAt: '2026-11-20T04:00:00.000Z', venue: 'own', hospitalName: 'Indore Care Hospital', surgeonId, surgeonName: expect.any(String),
      chargesPaise: 4_500_000, instructions: 'Nil by mouth after 10 pm', consentDocumentIds: [consent],
    });
    expect(list[1]).toMatchObject({ venue: 'partner', hospitalName: 'Bhopal Partner Hospital', chargesPaise: 9_000_000, status: 'done', consentDocumentIds: [] });
    expect(list[1]).not.toHaveProperty('instructions');
  });

  it('never shows venue payments, team, checklist, op note or staff fields', async () => {
    const text = await (await get('/patient/surgeries', A)).text();
    for (const hidden of [
      '6123400', 'VENUE-REF-1', 'venuePayment', 'amountPaise', 'teamIds', nurseId, 'checklist', 'CHECKLIST-INTERNAL', 'opNote', 'OPNOTE-INTERNAL',
      'createdBy', 'updatedBy', 'dev-surgeon', 'partnerHospitalId', partnerId,
    ]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("a family member's surgeries; a sensitive label keeps the surgery but drops its consent ids", async () => {
    const list = (await (await get(`/patient/surgeries?patientId=${sita}`, A)).json()) as Record<string, unknown>[];
    expect(list).toEqual([expect.objectContaining({ id: sitaSurgery, consentDocumentIds: [sitaConsent] })]);
    await withLabel(sita, async () => {
      const labelled = (await (await get(`/patient/surgeries?patientId=${sita}`, A)).json()) as Record<string, unknown>[];
      expect(labelled).toEqual([expect.objectContaining({ id: sitaSurgery, consentDocumentIds: [] })]);
    });
  });

  it('the same generic 403 for another patient, an unknown or a bad patientId', async () => {
    const other = await get(`/patient/surgeries?patientId=${ramesh}`, B);
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual(generic403);
    expect((await get(`/patient/surgeries?patientId=${seedId('9a710000', 999)}`, A)).status).toBe(403);
    expect((await get('/patient/surgeries?patientId=nope', A)).status).toBe(403);
    expect(await (await get('/patient/surgeries', B)).json()).toEqual([]);
  });
});
