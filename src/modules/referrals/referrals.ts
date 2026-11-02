import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { assertReferrer } from './referrers.js';

// Who sent which patient (api-list.md Referral). No fee or commission is ever kept.

export const REFERRAL_STATUSES = ['received', 'seen', 'admitted', 'surgery', 'discharged'] as const;

export interface Referral extends Omit<BaseFields, 'status'> {
  status: (typeof REFERRAL_STATUSES)[number];
  patientId: string;
  referrerId: string;
  /** YYYY-MM-DD. */
  date: string;
  reason?: string;
}

export const REFERRAL_COLUMNS = 'referrals.*, referral_date::text AS date_text';

export function toReferral(r: Record<string, unknown>): Referral {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as Referral['status'],
    patientId: String(r.patient_id),
    referrerId: String(r.referrer_id),
    date: String(r.date_text ?? r.referral_date),
    ...(r.reason != null && { reason: String(r.reason) }),
  };
}

/** #143: 404 for no patient; 422 for an unknown or merged referrer or a date after today. Starts as received. */
export async function addReferral(
  db: Queryable,
  patientId: string,
  input: { referrerId: string; date?: string; reason?: string },
  by: string,
  now = new Date(),
): Promise<Referral> {
  const patient = await getPatient(db, patientId);
  await assertReferrer(db, input.referrerId);
  const today = indiaDate(now);
  if (input.date && input.date > today) throw new AppError(422, 'validation_failed', 'date: after today');
  const { rows } = await db.query(
    `INSERT INTO referrals (id, status, created_by, updated_by, patient_id, referrer_id, referral_date, reason)
     VALUES ($1, 'received', $2, $2, $3, $4, $5, $6) RETURNING ${REFERRAL_COLUMNS}`,
    [randomUUID(), by, patient.id, input.referrerId, input.date ?? today, input.reason ?? null],
  );
  return toReferral(rows[0] as Record<string, unknown>);
}

export interface ReferralQuery extends PageQuery {
  referrerId?: string;
  /** YYYY-MM-DD, both days included. */
  from?: string;
  to?: string;
}

/** #144: newest referral date first; voided ones are left out. */
export async function listReferrals(db: Queryable, query: ReferralQuery): Promise<Page<Referral>> {
  const where = ['voided_at IS NULL'];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (query.referrerId) add('referrer_id = ?', query.referrerId);
  if (query.from) add('referral_date >= ?', query.from);
  if (query.to) add('referral_date <= ?', query.to);
  return pageRows(db, { select: `SELECT ${REFERRAL_COLUMNS} FROM referrals`, where, params, orderBy: ['referral_date', 'created_at', 'id'] }, query, toReferral);
}
