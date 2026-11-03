import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { getPatient } from '../patients/patients.js';
import { UUID } from '../users/users.js';
import { ruleForSub } from './inactive-settings.js';

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

/**
 * #29: asks to open a patient's record. 409 if the caller already has a pending request for this patient, or an
 * approved one that is still valid.
 */
export async function createAccessRequest(
  db: Queryable,
  input: { patientId: string; reason: string },
  by: string,
  now = new Date(),
): Promise<AccessRequest> {
  await getPatient(db, input.patientId).catch(() => {
    throw new AppError(422, 'invalid_input', 'patientId: no such patient');
  });
  const open = await db.query(
    `SELECT status FROM access_requests WHERE requested_by = $1 AND patient_id = $2
       AND (status = 'pending' OR (status = 'approved' AND valid_until > $3))`,
    [by, input.patientId, now],
  );
  if (open.rows[0]) {
    const pending = open.rows[0].status === 'pending';
    throw new AppError(409, pending ? 'already_pending' : 'already_approved', pending ? 'you already asked; it is waiting for approval' : 'you already have access');
  }
  const { rows } = await db.query(
    `INSERT INTO access_requests (id, status, created_by, updated_by, patient_id, requested_by, reason)
     VALUES ($1, 'pending', $2, $2, $3, $2, $4) RETURNING *`,
    [randomUUID(), by, input.patientId, input.reason],
  );
  return toAccessRequest(rows[0] as Record<string, unknown>, now);
}

/** An access request as the admin screens show it: requestedBy / approverId as users.id, with the UHID and name. */
export interface AdminAccessRequest extends AccessRequest {
  uhid?: string;
  requestedByName?: string;
}

// users.id and the names come from joins; the stored sub is kept when no user row has it.
const ADMIN_SELECT = `SELECT * FROM (SELECT a.*, p.uhid, u.id AS user_row_id, u.name AS user_name, ap.id AS approver_row_id
  FROM access_requests a LEFT JOIN patients p ON p.id::text = a.patient_id
  LEFT JOIN users u ON u.cognito_sub = a.requested_by LEFT JOIN users ap ON ap.cognito_sub = a.approver_id) x`;

function toAdminAccessRequest(r: Record<string, unknown>, now: Date): AdminAccessRequest {
  const request = toAccessRequest(r, now);
  return {
    ...request,
    requestedBy: String(r.user_row_id ?? r.requested_by),
    ...(request.approverId !== undefined && { approverId: String(r.approver_row_id ?? r.approver_id) }),
    ...(r.uhid != null && { uhid: String(r.uhid) }),
    ...(r.user_name != null && { requestedByName: String(r.user_name) }),
  };
}

/** One request as the admin screens show it; 404 if there is none. */
export async function getAdminAccessRequest(db: Queryable, id: string, now = new Date()): Promise<AdminAccessRequest> {
  const { rows } = await db.query(`${ADMIN_SELECT} WHERE id = $1`, [id]);
  if (!rows[0]) throw new AppError(404, 'not_found');
  return toAdminAccessRequest(rows[0] as Record<string, unknown>, now);
}

/** #174: by status (default pending). Pending ones oldest first, so none waits unseen; the rest newest first. */
export function listAccessRequests(
  db: Queryable,
  query: PageQuery & { status?: AccessRequestStatus },
  now = new Date(),
): Promise<Page<AdminAccessRequest>> {
  const status = query.status ?? 'pending';
  const params: unknown[] = status === 'approved' || status === 'expired' ? [now] : [];
  const spec = { select: ADMIN_SELECT, where: [statusFilter(status, '$1')], params, orderBy: ['created_at', 'id'], direction: status === 'pending' ? ('asc' as const) : ('desc' as const) };
  return pageRows(db, spec, query, (r) => toAdminAccessRequest(r, now));
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * #175 / #176: a Head Doctor or Admin decides a pending request. The approved row itself is the access: while
 * valid_until is ahead, the requester opens the patient (patient-access.ts). 404 if there is none, 409 if it is not
 * pending, 403 for the person who asked. The approver's note (approve) or reason (reject) is kept with the row.
 */
export async function decideAccessRequest(
  db: Queryable,
  id: string,
  decision: { approve: true; hours?: number; note?: string } | { approve: false; reason: string },
  by: { sub: string; isAdmin: boolean },
  now = new Date(),
): Promise<AdminAccessRequest> {
  const { rows } = UUID.test(id) ? await db.query('SELECT version, status, requested_by FROM access_requests WHERE id = $1', [id]) : { rows: [] };
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found');
  if (row.requested_by === by.sub) throw new AppError(403, 'forbidden', "you can't decide your own request");
  if (row.status !== 'pending') throw new AppError(409, 'conflict', `this request is already ${row.status}`);
  // The requester's setting says who approves (Head Doctor or Admin) and, unless the approver names hours, for how long.
  const rule = await ruleForSub(db, String(row.requested_by));
  if (rule.approver === 'admin' && !by.isAdmin) throw new AppError(403, 'forbidden', "this person's requests are decided by an Admin");
  const set = decision.approve
    ? {
        status: 'approved', approver_id: by.sub, decided_at: now, decision_reason: decision.note ?? null,
        valid_until: new Date(now.getTime() + (decision.hours ?? rule.accessHours) * HOUR_MS),
      }
    : { status: 'rejected', approver_id: by.sub, decided_at: now, decision_reason: decision.reason };
  await updateRecord(db, 'access_requests', { id, version: Number(row.version), by: by.sub, set });
  return getAdminAccessRequest(db, id, now);
}
