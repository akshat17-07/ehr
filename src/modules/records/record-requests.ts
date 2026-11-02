import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from '../patients/patients.js';

// Copies of a patient's record (api-list.md RecordRequest). Each request is due 72 hours after it was made.

export const RECORD_REQUEST_STATUSES = ['pending', 'fulfilled', 'rejected'] as const;
export const RECORD_SCOPES = ['full', 'encounter', 'documents'] as const;
export const RECORD_REQUEST_HOURS = 72;

export interface RecordRequest extends Omit<BaseFields, 'status'> {
  status: (typeof RECORD_REQUEST_STATUSES)[number];
  patientId: string;
  requestedBy: 'patient' | 'counter';
  scope: (typeof RECORD_SCOPES)[number];
  encounterIds?: string[];
  includeSensitive: boolean;
  email: string;
  dueBy: string;
  shareLinkExpiresAt?: string;
}

export function toRecordRequest(r: Record<string, unknown>): RecordRequest {
  const encounterIds = JSON.parse(String(r.encounter_ids ?? '[]')) as string[];
  const created = r.created_at as Date;
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as RecordRequest['status'],
    patientId: String(r.patient_id),
    requestedBy: r.requested_by as RecordRequest['requestedBy'],
    scope: r.scope as RecordRequest['scope'],
    ...(encounterIds.length > 0 && { encounterIds }),
    includeSensitive: r.include_sensitive === true,
    email: String(r.email),
    dueBy: new Date(created.getTime() + RECORD_REQUEST_HOURS * 3_600_000).toISOString(),
    ...(r.share_link_expires_at != null && { shareLinkExpiresAt: (r.share_link_expires_at as Date).toISOString() }),
  };
}

export interface RecordRequestQuery extends PageQuery {
  status?: RecordRequest['status'];
  /** true: pending past the 72 hours; false: all others. */
  overdue?: 'true' | 'false';
}

/** #145: oldest first, so the request due soonest is on top. */
export async function listRecordRequests(db: Queryable, query: RecordRequestQuery, now = new Date()): Promise<Page<RecordRequest>> {
  const where = ['voided_at IS NULL'];
  const params: unknown[] = [];
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  if (query.overdue) {
    const overdue = `(status = 'pending' AND created_at < $${params.push(new Date(now.getTime() - RECORD_REQUEST_HOURS * 3_600_000))})`;
    where.push(query.overdue === 'true' ? overdue : `NOT ${overdue}`);
  }
  return pageRows(db, { select: 'SELECT * FROM record_requests', where, params, orderBy: ['created_at', 'id'], direction: 'asc' }, query, toRecordRequest);
}
