import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { pageQuery, pageRows, type Page } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';

// Patient rights requests under the DPDP Act (api-list.md RightsRequest). Patients file them (#390, #391); the
// compliance officer lists (#332) and responds (#333). status: open / closed.

export const RIGHTS_KINDS = ['access', 'correction', 'grievance', 'withdraw_consent'] as const;
export const RIGHTS_STATUSES = ['open', 'closed'] as const;
export const RIGHTS_OUTCOMES = ['done', 'partly_done', 'refused'] as const;

/** The DPDP grievance window: a response is due this many days after the request, for every kind. */
export const RESPONSE_DAYS = 90;

export const rightsListQuery = pageQuery
  .extend({ status: z.enum(RIGHTS_STATUSES).optional(), kind: z.enum(RIGHTS_KINDS).optional() })
  .strict();
export type RightsListQuery = z.infer<typeof rightsListQuery>;

export interface RightsRequest {
  id: string;
  version: number;
  status: string;
  createdAt: string;
  patientId: string;
  uhid: string | null;
  patientName: string | null;
  kind: (typeof RIGHTS_KINDS)[number];
  text: string;
  response: string | null;
  outcome: (typeof RIGHTS_OUTCOMES)[number] | null;
  outcomeReason: string | null;
  respondedAt: string | null;
  respondedBy: string | null;
  dueBy: string;
}

// respondedBy is users.id; the stored sub is kept when no user row has it.
const SELECT = `SELECT r.*, p.uhid, p.name AS patient_name, u.id AS responder_row_id
  FROM rights_requests r LEFT JOIN patients p ON p.id = r.patient_id LEFT JOIN users u ON u.cognito_sub = r.responded_by`;

export function toRightsRequest(r: Record<string, unknown>): RightsRequest {
  const base = baseFields(r as unknown as BaseRow);
  const createdAt = r.created_at as Date;
  return {
    ...base,
    patientId: String(r.patient_id),
    uhid: r.uhid == null ? null : String(r.uhid),
    patientName: r.patient_name == null ? null : String(r.patient_name),
    kind: r.kind as RightsRequest['kind'],
    text: String(r.text),
    response: r.response == null ? null : String(r.response),
    outcome: r.outcome == null ? null : (r.outcome as RightsRequest['outcome']),
    outcomeReason: r.outcome_reason == null ? null : String(r.outcome_reason),
    respondedAt: r.responded_at == null ? null : (r.responded_at as Date).toISOString(),
    respondedBy: r.responded_by == null ? null : String(r.responder_row_id ?? r.responded_by),
    dueBy: new Date(createdAt.getTime() + RESPONSE_DAYS * 86_400_000).toISOString(),
  };
}

/** #332: oldest first, so none waits unseen. */
export function listRightsRequests(db: Queryable, query: RightsListQuery): Promise<Page<RightsRequest>> {
  const where: string[] = ['r.voided_at IS NULL'];
  const params: unknown[] = [];
  if (query.status) where.push(`r.status = $${params.push(query.status)}`);
  if (query.kind) where.push(`r.kind = $${params.push(query.kind)}`);
  return pageRows(db, { select: SELECT, where, params, orderBy: ['r.created_at', 'r.id'], direction: 'asc' }, query, toRightsRequest);
}
