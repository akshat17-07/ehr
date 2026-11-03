import type { Queryable } from '../../db/migrate.js';
import type { Permission } from '../../permissions/catalog.js';

// The approvals inbox (#173, api-list.md Approval): everything waiting for a second person that this user may
// decide. Each kind needs its own permission, and nobody sees what they asked for themselves (they can't approve it).
// requestedBy is users.id (the stored sub when no user row has it); requestedByName is added for the screen.

export const APPROVAL_KINDS = ['access_request', 'refund', 'discount', 'payroll', 'patient_merge'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export interface Approval {
  kind: ApprovalKind;
  id: string;
  summary: string;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
}

const rupees = (paise: unknown) => '₹' + (Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Per kind: the permission, and a query giving id, by (sub), at and the summary parts. $1 is the caller's sub. */
const SOURCES: Record<ApprovalKind, { permission: Permission; sql: string; summary: (r: Record<string, unknown>) => string }> = {
  access_request: {
    permission: 'approval.access',
    sql: `SELECT a.id, a.requested_by AS by, a.created_at AS at, a.reason, p.uhid FROM access_requests a
          LEFT JOIN patients p ON p.id::text = a.patient_id WHERE a.status = 'pending' AND a.requested_by <> $1`,
    summary: (r) => `Open the record of ${r.uhid ?? 'a patient'}: ${r.reason}`,
  },
  refund: {
    permission: 'approval.refund',
    sql: `SELECT r.id, r.created_by AS by, r.created_at AS at, r.amount_paise, r.reason, p.uhid FROM refunds r
          LEFT JOIN patients p ON p.id = r.patient_id WHERE r.status = 'pending' AND r.created_by <> $1`,
    summary: (r) => `Refund ${rupees(r.amount_paise)} to ${r.uhid ?? 'a patient'}: ${r.reason}`,
  },
  discount: {
    permission: 'approval.discount',
    sql: `SELECT d.id, d.created_by AS by, d.created_at AS at, d.amount_paise, d.reason, p.uhid FROM discounts d
          LEFT JOIN bills b ON b.id = d.bill_id LEFT JOIN patients p ON p.id = b.patient_id
          WHERE d.status = 'pending' AND d.created_by <> $1`,
    summary: (r) => `Discount ${rupees(r.amount_paise)} for ${r.uhid ?? 'a patient'}: ${r.reason}`,
  },
  payroll: {
    permission: 'approval.payroll',
    sql: `SELECT id, run_by AS by, created_at AS at, month, total_net_paise FROM payroll_runs WHERE status = 'draft' AND run_by <> $1`,
    summary: (r) => `Payroll for ${r.month}: ${rupees(r.total_net_paise)} net`,
  },
  patient_merge: {
    permission: 'patient.merge',
    sql: `SELECT m.id, m.proposed_by AS by, m.created_at AS at, m.reason, k.uhid AS keep_uhid, o.uhid AS merge_uhid
          FROM patient_merges m LEFT JOIN patients k ON k.id = m.keep_patient_id LEFT JOIN patients o ON o.id = m.merge_patient_id
          WHERE m.status = 'pending' AND m.proposed_by <> $1`,
    summary: (r) => `Merge ${r.merge_uhid ?? 'a patient'} into ${r.keep_uhid ?? 'a patient'}: ${r.reason}`,
  },
};

/** At most this many of each kind; the oldest come first, so nothing waits unseen. */
const PER_KIND = 200;

/** #173: oldest first. `permissions` are the caller's (effective) permissions. */
export async function listApprovals(db: Queryable, callerSub: string, permissions: readonly string[], kind?: ApprovalKind): Promise<Approval[]> {
  const kinds = APPROVAL_KINDS.filter((k) => (kind === undefined || k === kind) && permissions.includes(SOURCES[k].permission));
  const lists = await Promise.all(
    kinds.map(async (k) => {
      const { rows } = await db.query(
        `SELECT s.*, u.id AS user_row_id, u.name AS user_name FROM (${SOURCES[k].sql}) s
         LEFT JOIN users u ON u.cognito_sub = s.by ORDER BY s.at, s.id LIMIT ${PER_KIND}`,
        [callerSub],
      );
      return rows.map(
        (r): Approval => ({
          kind: k,
          id: String(r.id),
          summary: SOURCES[k].summary(r),
          requestedBy: String(r.user_row_id ?? r.by),
          ...(r.user_name != null && { requestedByName: String(r.user_name) }),
          requestedAt: (r.at as Date).toISOString(),
        }),
      );
    }),
  );
  return lists.flat().sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
}
