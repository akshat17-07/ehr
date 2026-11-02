import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import type { BaseFields } from '../patients/patients.js';
import { getBill, toBill, type Bill } from './bills.js';

// Payments (api-list.md Payment) against a final bill. Cash is capped by Income Tax Act sec 269ST: no ₹2,00,000 or
// more in cash from one person in a day, or for one bill.

export const PAYMENT_MODES = ['cash', 'upi', 'card', 'deposit'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** Sec 269ST: ₹2,00,000 in paise. Cash that reaches it is refused. */
export const CASH_LIMIT_PAISE = 20_000_000;

export interface Payment extends BaseFields {
  billId: string;
  amountPaise: number;
  mode: PaymentMode;
  reference?: string;
  depositId?: string;
  receivedBy: string;
  at: string;
}

export function toPayment(r: Record<string, unknown>): Payment {
  const base = baseFields(r as unknown as BaseRow);
  return {
    ...base,
    billId: String(r.bill_id),
    amountPaise: Number(r.amount_paise),
    mode: r.mode as PaymentMode,
    ...(r.reference != null && { reference: String(r.reference) }),
    ...(r.deposit_id != null && { depositId: String(r.deposit_id) }),
    receivedBy: base.createdBy,
    at: base.createdAt,
  };
}

/** A bill's payments, oldest first. */
export async function billPayments(db: Queryable, billId: string): Promise<Payment[]> {
  const { rows } = await db.query('SELECT * FROM payments WHERE bill_id = $1 AND voided_at IS NULL ORDER BY created_at, id', [billId]);
  return rows.map(toPayment);
}

/** Sum of a query's amount_paise. */
const sum = async (db: Queryable, sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0]?.sum ?? 0);

/**
 * 422 cash_limit if this cash would bring the patient's cash for the day (bill payments and deposits),
 * or for the bill, to ₹2,00,000.
 */
export async function assertCashLimit(db: Queryable, patientId: string, billId: string | undefined, amountPaise: number, now: Date) {
  const dayStart = indiaDayStart(indiaDate(now));
  const cashSince = (table: string) =>
    sum(db, `SELECT COALESCE(SUM(amount_paise), 0)::text AS sum FROM ${table} WHERE patient_id = $1 AND mode = 'cash' AND voided_at IS NULL AND created_at >= $2`, [
      patientId,
      dayStart,
    ]);
  const today = (await cashSince('payments')) + (await cashSince('deposits'));
  const onBill = billId
    ? await sum(db, `SELECT COALESCE(SUM(amount_paise), 0)::text AS sum FROM payments WHERE bill_id = $1 AND mode = 'cash' AND voided_at IS NULL`, [billId])
    : 0;
  if (Math.max(today, onBill) + amountPaise >= CASH_LIMIT_PAISE) {
    throw new AppError(422, 'cash_limit', 'cash of ₹2,00,000 or more from one person in a day or for one bill is not allowed (sec 269ST); take UPI or card');
  }
}

/** Records a payment on a bill and moves its status, inside the caller's transaction. */
export async function addPayment(
  tx: Queryable,
  bill: Bill,
  input: { amountPaise: number; mode: PaymentMode; reference?: string; depositId?: string },
  by: string,
): Promise<{ payment: Payment; bill: Bill }> {
  const paidPaise = bill.paidPaise + input.amountPaise;
  const row = await updateRecord(tx, 'bills', {
    id: bill.id,
    version: bill.version,
    by,
    set: { paid_paise: paidPaise, status: paidPaise >= bill.totalPaise ? 'paid' : 'part_paid' },
  });
  const { rows } = await tx.query(
    `INSERT INTO payments (id, status, created_by, updated_by, bill_id, patient_id, amount_paise, mode, reference, deposit_id)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [randomUUID(), by, bill.id, bill.patientId, input.amountPaise, input.mode, input.reference ?? null, input.depositId ?? null],
  );
  return { payment: toPayment(rows[0] as Record<string, unknown>), bill: toBill(row) };
}

/** 409 not_payable unless the bill is final or part paid; 422 for more than is due; 422 cash_limit. */
export async function payBill(
  db: Queryable,
  billId: string,
  input: { amountPaise: number; mode: Exclude<PaymentMode, 'deposit'>; reference?: string },
  by: string,
  now = new Date(),
): Promise<{ payment: Payment; bill: Bill }> {
  const bill = await getBill(db, billId);
  if (bill.status !== 'final' && bill.status !== 'part_paid') throw new AppError(409, 'not_payable', 'a bill is paid once final; this one is ' + bill.status);
  if (input.amountPaise > bill.duePaise) throw new AppError(422, 'validation_failed', `amountPaise: more than the ${bill.duePaise} due`);
  if (input.mode === 'cash') await assertCashLimit(db, bill.patientId, bill.id, input.amountPaise, now);
  return withTransaction(db, (tx) => addPayment(tx, bill, input, by));
}
