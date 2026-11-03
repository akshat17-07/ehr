import type { Queryable } from '../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../db/page.js';
import { getPatient } from '../modules/patients/patients.js';
import { indiaDayStart } from '../time/india.js';
import { fromRow, type AuditEvent } from './log.js';

/** An audit row as the admin screens show it: userId as users.id (the stored sub when no user has it), with the name. */
export interface AdminAuditEvent extends AuditEvent {
  userName?: string;
}

const SELECT = `SELECT a.seq::text AS seq_text, a.id::text AS id, a.at, a.role, a.action, a.patient_id::text AS patient_id,
  a.record_type, a.record_id, a.changes, a.reason, a.ip, a.device, a.prev_hash, a.hash, a.seq,
  COALESCE(u.id::text, a.user_id) AS user_id, u.name AS user_name
  FROM audit_events a LEFT JOIN users u ON u.cognito_sub = a.user_id`;

/**
 * #188: everything done to or looked at in one patient's record, newest first. from / to are India days (inclusive).
 * 404 if there is no such patient. The log itself is append-only and hash chained (audit/log.ts).
 */
export async function listPatientAccessLog(
  db: Queryable,
  patientId: string,
  query: PageQuery & { from?: string; to?: string },
): Promise<Page<AdminAuditEvent>> {
  await getPatient(db, patientId);
  const params: unknown[] = [patientId];
  const where = ['a.patient_id = $1'];
  if (query.from) where.push(`a.at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`a.at < $${params.push(new Date(indiaDayStart(query.to).getTime() + 86_400_000))}`);
  return pageRows(db, { select: SELECT, where, params, orderBy: ['a.seq'] }, query, (r) => ({
    ...fromRow(r),
    ...(r.user_name != null && { userName: String(r.user_name) }),
  }));
}
