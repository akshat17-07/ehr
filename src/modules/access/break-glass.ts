import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDayStart } from '../../time/india.js';
import { createAlert } from '../alerts/alerts.js';
import { getPatient } from '../patients/patients.js';
import { UUID } from '../users/users.js';

// Break-glass (api-list.md BreakGlassEvent): in an emergency a doctor or nurse opens a record they would otherwise
// have to ask for (#30). It works at once for 1 hour, every Head Doctor and Admin is alerted, and each event is
// reviewed later (#183, #184).

export const BREAK_GLASS_HOURS = 1;

export const REVIEW_OUTCOMES = ['justified', 'not_justified'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

export interface BreakGlassEvent {
  id: string;
  patientId: string;
  userId: string;
  reason: string;
  at: string;
  validUntil: string;
  reviewedBy?: string;
  reviewOutcome?: ReviewOutcome;
  reviewNote?: string;
}

export function toBreakGlassEvent(r: Record<string, unknown>): BreakGlassEvent {
  return {
    id: String(r.id),
    patientId: String(r.patient_id),
    userId: String(r.user_id),
    reason: String(r.reason),
    at: (r.at as Date).toISOString(),
    validUntil: (r.valid_until as Date).toISOString(),
    ...(r.reviewed_by != null && { reviewedBy: String(r.reviewed_by) }),
    ...(r.review_outcome != null && { reviewOutcome: r.review_outcome as ReviewOutcome }),
    ...(r.review_note != null && { reviewNote: String(r.review_note) }),
  };
}

/** #30: opens the patient's record to `by` for an hour and alerts the Head Doctors and Admins (not the caller). */
export async function breakGlass(db: Queryable, patientId: string, reason: string, by: string, now = new Date()): Promise<BreakGlassEvent> {
  const patient = await getPatient(db, patientId, now);
  const validUntil = new Date(now.getTime() + BREAK_GLASS_HOURS * 3_600_000);
  const { rows } = await db.query(
    `INSERT INTO break_glass_events (id, status, created_by, updated_by, patient_id, user_id, reason, at, valid_until)
     VALUES ($1, 'active', $2, $2, $3, $2, $4, $5, $6) RETURNING *`,
    [randomUUID(), by, patient.id, reason, now, validUntil],
  );
  const event = toBreakGlassEvent(rows[0] as Record<string, unknown>);

  const caller = await db.query('SELECT name FROM users WHERE cognito_sub = $1', [by]);
  const who = caller.rows[0] ? String(caller.rows[0].name) : by;
  const approvers = await db.query(
    "SELECT cognito_sub FROM users WHERE active AND type IN ('head_doctor', 'admin') AND cognito_sub <> $1",
    [by],
  );
  // The alert names the UHID, not the patient: alerts show on screens other people may see.
  for (const r of approvers.rows) {
    await createAlert(db, {
      userId: String(r.cognito_sub),
      kind: 'breakglass',
      title: `Break-glass: ${patient.uhid}`,
      body: `${who} used emergency access to ${patient.uhid}: ${reason}`,
      link: `/patients/${patient.id}`,
      by,
    });
  }
  return event;
}

/** A break-glass event as the admin screens show it: userId / reviewedBy as users.id, with the UHID and the name. */
export interface AdminBreakGlassEvent extends BreakGlassEvent {
  uhid?: string;
  userName?: string;
}

// users.id and the names come from joins; the stored sub is kept when no user row has it.
const ADMIN_SELECT = `SELECT * FROM (SELECT b.*, p.uhid, u.id AS user_row_id, u.name AS user_name, rv.id AS reviewer_row_id
  FROM break_glass_events b LEFT JOIN patients p ON p.id = b.patient_id
  LEFT JOIN users u ON u.cognito_sub = b.user_id LEFT JOIN users rv ON rv.cognito_sub = b.reviewed_by) x`;

function toAdminEvent(r: Record<string, unknown>): AdminBreakGlassEvent {
  const event = toBreakGlassEvent(r);
  return {
    ...event,
    userId: String(r.user_row_id ?? r.user_id),
    ...(event.reviewedBy !== undefined && { reviewedBy: String(r.reviewer_row_id ?? r.reviewed_by) }),
    ...(r.uhid != null && { uhid: String(r.uhid) }),
    ...(r.user_name != null && { userName: String(r.user_name) }),
  };
}

export async function getAdminBreakGlassEvent(db: Queryable, id: string): Promise<AdminBreakGlassEvent> {
  const { rows } = UUID.test(id) ? await db.query(`${ADMIN_SELECT} WHERE id = $1`, [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found');
  return toAdminEvent(rows[0] as Record<string, unknown>);
}

/**
 * #183: break-glass events, newest first; with reviewed=false oldest first, so none waits unseen. from / to are
 * India days (inclusive) on the time of use.
 */
export function listBreakGlassEvents(
  db: Queryable,
  query: PageQuery & { reviewed?: boolean; from?: string; to?: string },
): Promise<Page<AdminBreakGlassEvent>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.reviewed !== undefined) where.push(query.reviewed ? 'reviewed_by IS NOT NULL' : 'reviewed_by IS NULL');
  if (query.from) where.push(`at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`at < $${params.push(new Date(indiaDayStart(query.to).getTime() + 86_400_000))}`);
  const direction = query.reviewed === false ? ('asc' as const) : ('desc' as const);
  return pageRows(db, { select: ADMIN_SELECT, where, params, orderBy: ['at', 'id'], direction }, query, toAdminEvent);
}

/**
 * #184: a Head Doctor or Admin records whether the emergency access was justified. 404 if there is no such event,
 * 409 if it was reviewed already, 403 for the person who used it (nobody reviews their own).
 */
export async function reviewBreakGlass(
  db: Queryable,
  id: string,
  review: { outcome: ReviewOutcome; note: string },
  by: string,
): Promise<AdminBreakGlassEvent> {
  const { rows } = UUID.test(id) ? await db.query('SELECT version, user_id, reviewed_by FROM break_glass_events WHERE id = $1', [id]) : { rows: [] };
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found');
  if (row.user_id === by) throw new AppError(403, 'forbidden', "you can't review your own emergency access");
  if (row.reviewed_by != null) throw new AppError(409, 'conflict', 'this event was already reviewed');
  await updateRecord(db, 'break_glass_events', {
    id,
    version: Number(row.version),
    by,
    set: { status: 'reviewed', reviewed_by: by, review_outcome: review.outcome, review_note: review.note },
  });
  return getAdminBreakGlassEvent(db, id);
}
