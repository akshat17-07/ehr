import { z } from 'zod';
import type { Queryable } from '../db/migrate.js';
import { pageQuery, pageRows, type Page, type PageQuery } from '../db/page.js';
import { getPatient } from '../modules/patients/patients.js';
import { indiaDayStart } from '../time/india.js';
import { AUDIT_ACTIONS, fromRow, verifyAuditChain, type AuditEvent } from './log.js';

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

export const auditListQuery = pageQuery
  .extend({
    userId: z.string().min(1).max(100).optional(),
    patientId: z.uuid().optional(),
    action: z.enum(AUDIT_ACTIONS).optional(),
    recordType: z.string().min(1).max(100).optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .strict();
export type AuditListQuery = z.infer<typeof auditListQuery>;

/** #340: the whole audit log, newest first. userId is users.id (or a stored sub that has no user). from / to are India days. */
export function listAudit(db: Queryable, query: AuditListQuery): Promise<Page<AdminAuditEvent>> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.userId) {
    const n = params.push(query.userId);
    where.push(`(u.id::text = $${n} OR a.user_id = $${n})`);
  }
  if (query.patientId) where.push(`a.patient_id = $${params.push(query.patientId)}`);
  if (query.action) where.push(`a.action = $${params.push(query.action)}`);
  if (query.recordType) where.push(`a.record_type = $${params.push(query.recordType)}`);
  if (query.from) where.push(`a.at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`a.at < $${params.push(new Date(indiaDayStart(query.to).getTime() + 86_400_000))}`);
  return pageRows(db, { select: SELECT, where, params, orderBy: ['a.seq'] }, query, (r) => ({
    ...fromRow(r),
    ...(r.user_name != null && { userName: String(r.user_name) }),
  }));
}

export interface AuditVerification {
  checkedAt: string;
  ok: boolean;
  rows: number;
  firstBrokenId?: string;
}

/** #341: walks the whole hash chain; firstBrokenId is the first row that was changed, or the row after a removed one. */
export async function verifyAudit(db: Queryable): Promise<AuditVerification> {
  const check = await verifyAuditChain(db);
  const total = Number((await db.query('SELECT count(*)::text AS n FROM audit_events')).rows[0]?.n ?? 0);
  if (check.ok) return { checkedAt: new Date().toISOString(), ok: true, rows: total };
  const broken = (await db.query('SELECT id::text AS id FROM audit_events WHERE audit_events.seq >= $1 ORDER BY audit_events.seq LIMIT 1', [check.brokenAt])).rows[0];
  return { checkedAt: new Date().toISOString(), ok: false, rows: total, ...(broken && { firstBrokenId: String(broken.id) }) };
}
