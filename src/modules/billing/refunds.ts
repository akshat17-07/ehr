import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';
import { getBill, toBill, type Bill } from './bills.js';

// Refunds (api-list.md Refund) of money taken on a bill. Up to the hospital's limit one is approved at once and taken
// off what the bill has been paid; above it, it waits for a second person (#177).

export const REFUND_MODES = ['cash', 'upi', 'card', 'bank'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

/** Used until the Admin sets a limit (#189): ₹1,000. */
export const DEFAULT_REFUND_LIMIT_PAISE = 100_000;

export interface Refund extends Omit<BaseFields, 'status'> {
  status: 'approved' | 'pending' | 'rejected' | 'paid';
  billId: string;
  patientId: string;
  amountPaise: number;
  mode: RefundMode;
  reason: string;
  reference?: string;
  approvedBy?: string;
}

export function toRefund(r: Record<string, unknown>): Refund {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as Refund['status'],
    billId: String(r.bill_id),
    patientId: String(r.patient_id),
    amountPaise: Number(r.amount_paise),
    mode: r.mode as RefundMode,
    reason: String(r.reason),
    ...(r.reference != null && { reference: String(r.reference) }),
    ...(r.approved_by != null && { approvedBy: String(r.approved_by) }),
  };
}

/** A bill's refunds, oldest first. */
export async function billRefunds(db: Queryable, billId: string): Promise<Refund[]> {
  const { rows } = await db.query('SELECT * FROM refunds WHERE bill_id = $1 ORDER BY created_at, id', [billId]);
  return rows.map(toRefund);
}

/** Takes an approved refund off what the bill has been paid (here, and when #177 approves one). */
export async function refundFromBill(tx: Queryable, bill: Bill, amountPaise: number, by: string): Promise<Bill> {
  const paidPaise = bill.paidPaise - amountPaise;
  const status = paidPaise <= 0 ? 'final' : paidPaise >= bill.totalPaise ? 'paid' : 'part_paid';
  return toBill(await updateRecord(tx, 'bills', { id: bill.id, version: bill.version, by, set: { paid_paise: paidPaise, status } }));
}

/** #129: 422 for more than was paid (less refunds waiting for approval). */
export async function addRefund(
  db: Queryable,
  billId: string,
  input: { amountPaise: number; mode: RefundMode; reason: string; reference?: string },
  by: string,
): Promise<Refund> {
  const bill = await getBill(db, billId);
  const { rows: pendingRows } = await db.query(`SELECT COALESCE(SUM(amount_paise), 0)::text AS sum FROM refunds WHERE bill_id = $1 AND status = 'pending'`, [billId]);
  const refundable = bill.paidPaise - Number(pendingRows[0]?.sum ?? 0);
  if (input.amountPaise > refundable) throw new AppError(422, 'validation_failed', `amountPaise: more than the ${Math.max(0, refundable)} paid on this bill`);
  const { rows } = await db.query('SELECT refund_limit_paise FROM hospital LIMIT 1');
  const limit = rows[0]?.refund_limit_paise == null ? DEFAULT_REFUND_LIMIT_PAISE : Number(rows[0].refund_limit_paise);
  const status = input.amountPaise > limit ? 'pending' : 'approved';
  return withTransaction(db, async (tx) => {
    if (status === 'approved') await refundFromBill(tx, bill, input.amountPaise, by);
    const { rows: inserted } = await tx.query(
      `INSERT INTO refunds (id, status, created_by, updated_by, bill_id, patient_id, amount_paise, mode, reason, reference)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [randomUUID(), status, by, billId, bill.patientId, input.amountPaise, input.mode, input.reason, input.reference ?? null],
    );
    return toRefund(inserted[0] as Record<string, unknown>);
  });
}
