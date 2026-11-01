import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';

// Access requests (api-list.md AccessRequest): staff ask to open an inactive patient's record (#29), and a
// Head Doctor or Admin approves for some hours or rejects (#175, #176). The row's status is pending, approved or
// rejected; an approved request reads as `expired` once valid_until has passed.

export const ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

export interface AccessRequest {
  id: string;
  version: number;
  status: AccessRequestStatus;
  patientId: string;
  requestedBy: string;
  reason: string;
  approverId?: string;
  decidedAt?: string;
  decisionReason?: string;
  validUntil?: string;
  createdAt: string;
}

export function toAccessRequest(r: Record<string, unknown>, now = new Date()): AccessRequest {
  const validUntil = (r.valid_until as Date | null) ?? null;
  const expired = r.status === 'approved' && validUntil !== null && validUntil <= now;
  return {
    id: String(r.id),
    version: Number(r.version),
    status: expired ? 'expired' : (r.status as AccessRequestStatus),
    patientId: String(r.patient_id),
    requestedBy: String(r.requested_by),
    reason: String(r.reason),
    ...(r.approver_id != null && { approverId: String(r.approver_id) }),
    ...(r.decided_at != null && { decidedAt: (r.decided_at as Date).toISOString() }),
    ...(r.decision_reason != null && { decisionReason: String(r.decision_reason) }),
    ...(validUntil !== null && { validUntil: validUntil.toISOString() }),
    createdAt: (r.created_at as Date).toISOString(),
  };
}

/** SQL filter for a status as the API shows it; `now` is the parameter holding the current time. */
export function statusFilter(status: AccessRequestStatus, now: string): string {
  if (status === 'approved') return `status = 'approved' AND valid_until > ${now}`;
  if (status === 'expired') return `status = 'approved' AND valid_until <= ${now}`;
  return `status = '${status}'`;
}

/** The caller's own requests, newest first (#5). */
export function listMyAccessRequests(
  db: Queryable,
  userId: string,
  query: PageQuery & { status?: AccessRequestStatus },
  now = new Date(),
): Promise<Page<AccessRequest>> {
  const where = ['requested_by = $1'];
  const params: unknown[] = [userId];
  if (query.status) {
    // Only approved / expired compare times; an unused parameter would be an error.
    if (query.status === 'approved' || query.status === 'expired') params.push(now);
    where.push(statusFilter(query.status, '$2'));
  }
  const spec = { select: 'SELECT * FROM access_requests', where, params, orderBy: ['created_at', 'id'] };
  return pageRows(db, spec, query, (r) => toAccessRequest(r, now));
}
