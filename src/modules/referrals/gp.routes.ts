import { Hono } from 'hono';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { pageQuery, pageRows } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { AppError } from '../../middleware/errors.js';
import { UUID } from '../users/users.js';
import { SUMMARY_SELECT, toDischargeSummary } from '../admissions/discharge.js';
import { hasSensitiveLabel } from '../portal/portal.js';
import { notOwnReferral, OWN_REFERRAL } from './gp-access.js';
import { REFERRAL_STATUSES } from './referrals.js';

// /other/gp/referrals (api-list.md #270-#271): a referring GP's view of its own referrals. Only the patient's name
// is shown (the GP sent them): no patient id, UHID, phone, staff ids or clinical data. A referral that is not the
// caller's, voided, unknown or malformed is one generic 403, never 404.

const listQuery = pageQuery.extend({ status: z.enum(REFERRAL_STATUSES).optional() });

const SELECT = `SELECT referrals.id, referrals.status, referrals.reason, referrals.updated_at, referrals.patient_id,
  referrals.referral_date::text AS date_text, patients.name AS patient_name
  FROM referrals JOIN patients ON patients.id = referrals.patient_id`;

// Mounted at /other/gp/referrals.
export const gpReferralsRoutes = new Hono<AuthEnv>()
  // #403
  .get('/', async (c) => {
    const query = listQuery.parse(c.req.query());
    const db = await dbOf(c);
    const where = [OWN_REFERRAL('$1')];
    const params: unknown[] = [userOf(c).sub];
    if (query.status) where.push(`referrals.status = $${params.push(query.status)}`);
    const page = await pageRows(
      db,
      { select: SELECT, where, params, orderBy: ['referrals.referral_date', 'referrals.created_at', 'referrals.id'] },
      query,
      (r) => ({ referralId: String(r.id), patientName: String(r.patient_name), date: String(r.date_text), status: String(r.status) }),
    );
    return c.json(page);
  })
  // #404
  .get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notOwnReferral();
    const db = await dbOf(c);
    const { rows } = await db.query(`${SELECT} WHERE referrals.id = $2 AND ${OWN_REFERRAL('$1')}`, [userOf(c).sub, id]);
    const r = rows[0] as Record<string, unknown> | undefined;
    if (!r) throw notOwnReferral();
    auditDetails(c, { patientId: String(r.patient_id), recordType: 'referral', recordId: id });
    return c.json({
      referralId: String(r.id),
      patientName: String(r.patient_name),
      date: String(r.date_text),
      ...(r.reason != null && { reason: String(r.reason) }),
      status: String(r.status),
      lastUpdate: (r.updated_at as Date).toISOString(),
    });
  })
  // #405 (api-list #272): the discharge summary of a referral the GP sent. Access first (generic 403), then the
  // patient's consent and labels (one no_consent 403), then the summary (404).
  .get('/:id/discharge-summary', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) throw notOwnReferral();
    const db = await dbOf(c);
    const { rows } = await db.query(
      `SELECT referrals.patient_id, referrals.referral_date::text AS date_text, patients.name AS patient_name
       FROM referrals JOIN patients ON patients.id = referrals.patient_id WHERE referrals.id = $2 AND ${OWN_REFERRAL('$1')}`,
      [userOf(c).sub, id],
    );
    const ref = rows[0] as Record<string, unknown> | undefined;
    if (!ref) throw notOwnReferral();
    const patientId = String(ref.patient_id);
    // A patient with any sensitive label gets the same answer as no consent, so the GP cannot tell that a label exists.
    if (!(await hasReferrerConsent(db, patientId)) || (await hasSensitiveLabel(db, patientId))) {
      throw new AppError(403, 'no_consent', 'the patient has not agreed to share this record with the referring doctor');
    }
    const found = await db.query(
      `${SUMMARY_SELECT} JOIN encounters ON encounters.id = discharge_summaries.encounter_id
       WHERE discharge_summaries.patient_id = $1 AND discharge_summaries.status = 'signed' AND discharge_summaries.voided_at IS NULL
         AND discharge_summaries.signed_at IS NOT NULL
         AND to_char(encounters.started_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') >= $2
       ORDER BY discharge_summaries.signed_at DESC, discharge_summaries.id DESC LIMIT 1`,
      [patientId, String(ref.date_text)],
    );
    if (!found.rows[0]) throw new AppError(404, 'not_found', 'no discharge summary yet');
    const s = toDischargeSummary(found.rows[0] as Record<string, unknown>);
    auditDetails(c, { patientId, recordType: 'discharge_summary', recordId: s.id });
    return c.json({
      referralId: id,
      patientName: String(ref.patient_name),
      diagnosisText: s.diagnosisText,
      course: s.course,
      ...(s.procedures !== undefined && { procedures: s.procedures }),
      medicinesOnDischarge: s.medicinesOnDischarge,
      advice: s.advice,
      ...(s.followUpDate !== undefined && { followUpDate: s.followUpDate }),
      signedAt: s.signedAt,
    });
  });

/** The patient's latest share_with_referrer answer (by given_at, voided rows ignored) is given and not withdrawn. */
async function hasReferrerConsent(db: Queryable, patientId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT given, withdrawn_at FROM consents WHERE patient_id = $1 AND kind = 'share_with_referrer' AND voided_at IS NULL
     ORDER BY given_at DESC, id DESC LIMIT 1`,
    [patientId],
  );
  const r = rows[0] as { given?: unknown; withdrawn_at?: unknown } | undefined;
  return r?.given === true && r.withdrawn_at == null;
}
