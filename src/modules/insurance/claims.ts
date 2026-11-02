import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { assertLinks } from '../billing/bills.js';
import { assertPatientDocuments } from '../documents/documents.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { UUID } from '../users/users.js';

// Insurance claims (api-list.md Claim, ClaimEvent). The TPA desk types in each step; the IRDAI timers (cashless
// pre-auth decided within 1 hour, discharge within 3 hours) are worked out when the claim is read.

export const CLAIM_KINDS = ['cashless_preauth', 'cashless_final', 'reimbursement'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const CLAIM_STATUSES = ['draft', 'submitted', 'query', 'approved', 'rejected', 'settled'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** IRDAI master circular on health insurance (2024): hours from the request to the insurer's answer. */
export const CLAIM_HOURS: Partial<Record<ClaimKind, number>> = { cashless_preauth: 1, cashless_final: 3 };

export interface ClaimEvent {
  id: string;
  claimId: string;
  status: ClaimStatus;
  note?: string;
  amountPaise?: number;
  at: string;
  by: string;
}

export interface Claim extends Omit<BaseFields, 'status'> {
  status: ClaimStatus;
  patientId: string;
  policyId: string;
  insurerId: string;
  admissionId?: string;
  kind: ClaimKind;
  amountClaimedPaise: number;
  amountApprovedPaise?: number;
  events: ClaimEvent[];
  documentIds: string[];
  /** While the insurer owes an answer on a cashless claim: when it is due. */
  dueBy?: string;
}

export function toClaimEvent(r: Record<string, unknown>): ClaimEvent {
  return {
    id: String(r.id),
    claimId: String(r.claim_id),
    status: r.to_status as ClaimStatus,
    ...(r.note != null && { note: String(r.note) }),
    ...(r.amount_paise != null && { amountPaise: Number(r.amount_paise) }),
    at: (r.created_at as Date).toISOString(),
    by: String(r.created_by),
  };
}

export function toClaim(r: Record<string, unknown>, events: ClaimEvent[] = []): Claim {
  const kind = r.kind as ClaimKind;
  const status = r.status as ClaimStatus;
  const hours = CLAIM_HOURS[kind];
  const dueBy = hours && status === 'submitted' && r.submitted_at != null ? new Date((r.submitted_at as Date).getTime() + hours * 3_600_000) : undefined;
  return {
    ...baseFields(r as unknown as BaseRow),
    status,
    patientId: String(r.patient_id),
    policyId: String(r.policy_id),
    insurerId: String(r.insurer_id),
    ...(r.admission_id != null && { admissionId: String(r.admission_id) }),
    kind,
    amountClaimedPaise: Number(r.amount_claimed_paise),
    ...(r.amount_approved_paise != null && { amountApprovedPaise: Number(r.amount_approved_paise) }),
    events,
    documentIds: JSON.parse(String(r.document_ids)) as string[],
    ...(dueBy && { dueBy: dueBy.toISOString() }),
  };
}

/** 404 for no claim (or not a UUID). With its events, oldest first. */
export async function getClaim(db: Queryable, id: string): Promise<Claim> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM claims WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such claim');
  const { rows: events } = await db.query('SELECT * FROM claim_events WHERE claim_id = $1 ORDER BY created_at, id', [id]);
  return toClaim(rows[0] as Record<string, unknown>, events.map(toClaimEvent));
}

export interface NewClaim {
  patientId: string;
  policyId: string;
  admissionId?: string;
  kind: ClaimKind;
  amountClaimedPaise: number;
  documentIds?: string[];
}

/** #134: a draft claim. 404 for no patient; 422 for a policy, admission or document that isn't the patient's. */
export async function createClaim(db: Queryable, input: NewClaim, by: string): Promise<Claim> {
  const patient = await getPatient(db, input.patientId);
  const { rows: policies } = UUID.test(input.policyId)
    ? await db.query('SELECT patient_id, insurer_id FROM policies WHERE id = $1 AND voided_at IS NULL', [input.policyId])
    : { rows: [] };
  if (policies[0]?.patient_id !== patient.id) throw new AppError(422, 'validation_failed', "policyId: not this patient's policy");
  await assertLinks(db, patient.id, { admissionId: input.admissionId });
  const documentIds = [...new Set(input.documentIds ?? [])];
  await assertPatientDocuments(db, patient.id, documentIds, 'documentIds');
  const id = randomUUID();
  await db.query(
    `INSERT INTO claims (id, status, created_by, updated_by, patient_id, policy_id, insurer_id, admission_id, kind, amount_claimed_paise, document_ids)
     VALUES ($1, 'draft', $2, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, by, patient.id, input.policyId, String(policies[0]?.insurer_id), input.admissionId ?? null, input.kind, input.amountClaimedPaise, JSON.stringify(documentIds)],
  );
  return getClaim(db, id);
}

export interface ClaimQuery extends PageQuery {
  status?: ClaimStatus;
  patientId?: string;
  insurerId?: string;
  overdue?: 'true' | 'false';
}

/** The events of several claims, by claim, oldest first. */
async function eventsOf(db: Queryable, ids: string[]): Promise<Map<string, ClaimEvent[]>> {
  const byClaim = new Map<string, ClaimEvent[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return byClaim;
  const { rows } = await db.query(`SELECT * FROM claim_events WHERE claim_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY created_at, id`, ids);
  for (const r of rows) byClaim.get(String(r.claim_id))?.push(toClaimEvent(r));
  return byClaim;
}

/** #135: newest first. overdue=true: cashless claims still waiting past their IRDAI time; false: all others. */
export async function listClaims(db: Queryable, query: ClaimQuery, now = new Date()): Promise<Page<Claim>> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  if (query.patientId) where.push(`patient_id = $${params.push(query.patientId)}`);
  if (query.insurerId) where.push(`insurer_id = $${params.push(query.insurerId)}`);
  if (query.overdue) {
    const late = Object.entries(CLAIM_HOURS)
      .map(([kind, hours]) => `(kind = $${params.push(kind)} AND submitted_at < $${params.push(new Date(now.getTime() - hours * 3_600_000))})`)
      .join(' OR ');
    const overdue = `(status = 'submitted' AND (${late}))`;
    where.push(query.overdue === 'true' ? overdue : `NOT ${overdue}`);
  }
  const page = await pageRows(db, { select: 'SELECT * FROM claims', where, params, orderBy: ['created_at', 'id'] }, query, (r) => toClaim(r));
  const events = await eventsOf(db, page.items.map((c) => c.id));
  return { ...page, items: page.items.map((c) => ({ ...c, events: events.get(c.id) ?? [] })) };
}

/** Which status each status may move to (typed in from the insurer's or TPA's letters and emails). */
export const CLAIM_MOVES: Record<ClaimStatus, ClaimStatus[]> = {
  draft: ['submitted'],
  submitted: ['query', 'approved', 'rejected'],
  query: ['submitted', 'approved', 'rejected'],
  approved: ['query', 'settled'],
  // Sent again after a rejection (with what was missing).
  rejected: ['submitted'],
  settled: [],
};

/**
 * #137: moves the claim to a new status and records the step. submitted starts the IRDAI timer again;
 * approved sets the approved amount (at most the claimed one). 409 bad_move for a move not in CLAIM_MOVES.
 */
export async function addClaimEvent(
  db: Queryable,
  id: string,
  input: { status: Exclude<ClaimStatus, 'draft'>; note?: string; amountPaise?: number },
  by: string,
  now = new Date(),
): Promise<ClaimEvent> {
  const claim = await getClaim(db, id);
  if (!CLAIM_MOVES[claim.status].includes(input.status)) {
    throw new AppError(409, 'bad_move', `a ${claim.status} claim can't become ${input.status}`, { allowed: CLAIM_MOVES[claim.status] });
  }
  if (input.status === 'approved' && input.amountPaise! > claim.amountClaimedPaise) {
    throw new AppError(422, 'validation_failed', `amountPaise: more than the ${claim.amountClaimedPaise} claimed`);
  }
  const set: Record<string, unknown> = { status: input.status };
  if (input.status === 'submitted') set.submitted_at = now;
  if (input.status === 'approved') set.amount_approved_paise = input.amountPaise;
  return withTransaction(db, async (tx) => {
    await updateRecord(tx, 'claims', { id, version: claim.version, by, set });
    const { rows } = await tx.query(
      `INSERT INTO claim_events (id, status, created_by, updated_by, created_at, updated_at, claim_id, to_status, note, amount_paise)
       VALUES ($1, 'active', $2, $2, $3, $3, $4, $5, $6, $7) RETURNING *`,
      [randomUUID(), by, now, id, input.status, input.note ?? null, input.amountPaise ?? null],
    );
    return toClaimEvent(rows[0] as Record<string, unknown>);
  });
}

/** #138: adds the patient's uploaded documents to the claim (ones already there are kept once). 422 for another patient's. */
export async function addClaimDocuments(db: Queryable, id: string, input: { documentIds: string[] }, by: string): Promise<Claim> {
  const claim = await getClaim(db, id);
  await assertPatientDocuments(db, claim.patientId, input.documentIds, 'documentIds');
  const documentIds = [...new Set([...claim.documentIds, ...input.documentIds])];
  if (documentIds.length === claim.documentIds.length) return claim;
  await updateRecord(db, 'claims', { id, version: claim.version, by, set: { document_ids: JSON.stringify(documentIds) } });
  return getClaim(db, id);
}
