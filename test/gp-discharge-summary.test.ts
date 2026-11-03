import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { withdrawConsent } from '../src/modules/patients/consents.js';

// #405: GET /other/gp/referrals/:id/discharge-summary: own referral, consent, no sensitive label, newest signed summary.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const gp = asStaff('dev-gp', ['gp']);
const doctor = asStaff('dev-doctor', ['doctor']);
const gpUserId = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-gp'")).rows[0]?.id);
const MED = seedId('de000000', 1);
const doctorId = seedId('a0000000', 3);

let made = 0;
async function newPatient(labels: string[] = []): Promise<string> {
  const id = randomUUID();
  made += 1;
  await db.query(
    `INSERT INTO patients (id, status, created_by, updated_by, uhid, name, name_search, sex, labels, allergies)
     VALUES ($1, 'active', 'test', 'test', $2, $3, $4, 'F', $5, '[]')`,
    [id, `U98${String(made).padStart(6, '0')}`, `Patient ${made}`, `patient ${made}`, JSON.stringify(labels)],
  );
  return id;
}

const ownReferrer = randomUUID();
await db.query(
  `INSERT INTO referrers (id, status, created_by, updated_by, name, name_search, user_id, pseudo) VALUES ($1, 'active', 'test', 'test', 'Dr GP', 'dr gp', $2, false)`,
  [ownReferrer, gpUserId],
);
const otherReferrer = randomUUID();
await db.query(
  `INSERT INTO referrers (id, status, created_by, updated_by, name, name_search, pseudo) VALUES ($1, 'active', 'test', 'test', 'Dr Other', 'dr other', false)`,
  [otherReferrer],
);

async function referral(patientId: string, date = '2026-02-01', referrerId = ownReferrer, voided = false) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO referrals (id, status, created_at, created_by, updated_by, patient_id, referrer_id, referral_date, voided_at, voided_by, void_reason)
     VALUES ($1, $2, '2026-02-01T00:00:00Z', 'test', 'test', $3, $4, $5, $6, $7, $8)`,
    [id, voided ? 'void' : 'received', patientId, referrerId, date, voided ? '2026-02-02T00:00:00Z' : null, voided ? 'test' : null, voided ? 'x' : null],
  );
  return id;
}

async function consent(patientId: string, givenAt: string, given = true, voided = false) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO consents (id, status, created_at, created_by, updated_by, voided_at, patient_id, kind, language, given, given_at)
     VALUES ($1, 'active', $2, 'test', 'test', $3, $4, 'share_with_referrer', 'en', $5, $2)`,
    [id, givenAt, voided ? givenAt : null, patientId, given],
  );
  return id;
}

async function summary(patientId: string, startedAt: string, status: 'draft' | 'signed', signedAt: string | null, diagnosis = 'Fracture') {
  const enc = randomUUID();
  await db.query(
    `INSERT INTO encounters (id, status, created_by, updated_by, patient_id, type, department_id, doctor_id, started_at)
     VALUES ($1, 'closed', 'test', 'test', $2, 'IPD', $3, $4, $5)`,
    [enc, patientId, MED, doctorId, startedAt],
  );
  const id = randomUUID();
  await db.query(
    `INSERT INTO discharge_summaries (id, status, created_by, updated_by, encounter_id, patient_id, diagnosis_text, course, medicines, advice, follow_up_date, signed_at, signed_by)
     VALUES ($1, $2, 'staff-x', 'staff-x', $3, $4, $5, 'Uneventful', '[]', 'Rest', '2026-12-01', $6, $7)`,
    [id, status, enc, patientId, diagnosis, signedAt, signedAt ? 'staff-x' : null],
  );
  return id;
}

const get = (id: string, who = gp) => app.request(`/other/gp/referrals/${id}/discharge-summary`, {}, who);
const auditCount = async (recordId: string) =>
  Number((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE record_type = 'discharge_summary' AND record_id = $1", [recordId])).rows[0]?.n);

/** A patient with consent, an own referral on 2026-02-01 and a signed summary after it. */
async function ready(labels: string[] = []) {
  const patientId = await newPatient(labels);
  const referralId = await referral(patientId);
  await consent(patientId, '2026-02-02T00:00:00Z');
  const summaryId = await summary(patientId, '2026-02-10T04:00:00Z', 'signed', '2026-02-14T10:00:00Z');
  return { patientId, referralId, summaryId };
}

describe('GET /other/gp/referrals/:id/discharge-summary', () => {
  it('returns exactly the allowed fields and audits the read', async () => {
    const { referralId, summaryId } = await ready();
    const res = await get(referralId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['advice', 'course', 'diagnosisText', 'followUpDate', 'medicinesOnDischarge', 'patientName', 'referralId', 'signedAt']);
    expect(body).toMatchObject({ referralId, diagnosisText: 'Fracture', course: 'Uneventful', advice: 'Rest', medicinesOnDischarge: [], followUpDate: '2026-12-01', signedAt: '2026-02-14T10:00:00.000Z' });
    expect(await auditCount(summaryId)).toBe(1);
  });

  it('403 no_consent without a consent, and for refused, withdrawn, voided or later-refused consent; no audit', async () => {
    const bodies: string[] = [];
    const check = async (patientId: string) => {
      const referralId = await referral(patientId);
      const summaryId = await summary(patientId, '2026-02-10T04:00:00Z', 'signed', '2026-02-14T10:00:00Z');
      const res = await get(referralId);
      expect(res.status).toBe(403);
      bodies.push(await res.text());
      expect(await auditCount(summaryId)).toBe(0);
    };
    await check(await newPatient()); // no row
    const refused = await newPatient();
    await consent(refused, '2026-02-02T00:00:00Z', false);
    await check(refused);
    const withdrawn = await newPatient();
    const cid = await consent(withdrawn, '2026-02-02T00:00:00Z');
    await withdrawConsent(db, cid, { byPatientId: withdrawn, by: 'test' });
    await check(withdrawn);
    const voided = await newPatient();
    await consent(voided, '2026-02-02T00:00:00Z', true, true);
    await check(voided);
    const later = await newPatient();
    await consent(later, '2026-02-02T00:00:00Z', true);
    await consent(later, '2026-02-05T00:00:00Z', false);
    await check(later);
    for (const b of bodies) expect(JSON.parse(b)).toMatchObject({ error: 'no_consent' });
    expect(new Set(bodies).size).toBe(1);
  });

  it('a sensitive label gives a body identical to the no-consent body', async () => {
    const noConsent = await newPatient();
    const plain = await (await get(await referral(noConsent))).text();
    const { referralId } = await ready(['hiv']);
    const res = await get(referralId);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(plain);
  });

  it('404 for a draft only, or a signed summary of an encounter before the referral date', async () => {
    const p1 = await newPatient();
    const r1 = await referral(p1);
    await consent(p1, '2026-02-02T00:00:00Z');
    await summary(p1, '2026-02-10T04:00:00Z', 'draft', null);
    expect((await get(r1)).status).toBe(404);
    const p2 = await newPatient();
    const r2 = await referral(p2, '2026-02-01');
    await consent(p2, '2026-02-02T00:00:00Z');
    await summary(p2, '2026-01-20T04:00:00Z', 'signed', '2026-01-25T10:00:00Z');
    const res = await get(r2);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('returns the newest signed summary of two', async () => {
    const p = await newPatient();
    const r = await referral(p);
    await consent(p, '2026-02-02T00:00:00Z');
    await summary(p, '2026-02-10T04:00:00Z', 'signed', '2026-02-14T10:00:00Z', 'Older');
    await summary(p, '2026-03-10T04:00:00Z', 'signed', '2026-03-14T10:00:00Z', 'Newer');
    expect(((await (await get(r)).json()) as { diagnosisText: string }).diagnosisText).toBe('Newer');
  });

  it('gives the generic forbidden for unrelated, voided, unknown and malformed referrals, and 403 to a doctor', async () => {
    const p = await newPatient();
    await consent(p, '2026-02-02T00:00:00Z');
    await summary(p, '2026-02-10T04:00:00Z', 'signed', '2026-02-14T10:00:00Z');
    const bodies: string[] = [];
    for (const id of [await referral(p, '2026-02-01', otherReferrer), await referral(p, '2026-02-01', ownReferrer, true), randomUUID(), 'not-a-uuid']) {
      const res = await get(id);
      expect(res.status).toBe(403);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ error: 'forbidden' });
    expect((await get(await referral(p), doctor)).status).toBe(403);
  });
});
