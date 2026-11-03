import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery, pageRows } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { UUID } from '../users/users.js';
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
  });
