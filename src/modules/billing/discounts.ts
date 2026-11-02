import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';
import { billLevelDiscount, billTotals, getBill, toBill, type Bill } from './bills.js';

// Discounts (api-list.md Discount) on a draft bill. Up to the hospital's limit one is applied at once; above it, it
// waits for a second person (#179) and the bill can't be finalised until then.

/** Used until the Admin sets a limit (#189): ₹1,000. */
export const DEFAULT_DISCOUNT_LIMIT_PAISE = 100_000;

export interface Discount extends Omit<BaseFields, 'status'> {
  status: 'applied' | 'pending' | 'rejected';
  billId: string;
  amountPaise: number;
  reason: string;
  approvedBy?: string;
}

export function toDiscount(r: Record<string, unknown>): Discount {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as Discount['status'],
    billId: String(r.bill_id),
    amountPaise: Number(r.amount_paise),
    reason: String(r.reason),
    ...(r.approved_by != null && { approvedBy: String(r.approved_by) }),
  };
}

/** A bill's discounts, oldest first. */
export async function billDiscounts(db: Queryable, billId: string): Promise<Discount[]> {
  const { rows } = await db.query('SELECT * FROM discounts WHERE bill_id = $1 ORDER BY created_at, id', [billId]);
  return rows.map(toDiscount);
}

/** Takes an approved discount off the bill's total (here, and when #179 approves one). */
export async function applyToBill(tx: Queryable, bill: Bill, amountPaise: number, by: string): Promise<Bill> {
  const set = billTotals(bill.lines, billLevelDiscount(bill) + amountPaise);
  return toBill(await updateRecord(tx, 'bills', { id: bill.id, version: bill.version, by, set }));
}

/** #121: 409 not_draft unless the bill is a draft; 422 for more than the bill's total. */
export async function addDiscount(db: Queryable, billId: string, input: { amountPaise: number; reason: string }, by: string): Promise<Discount> {
  const bill = await getBill(db, billId);
  if (bill.status !== 'draft') throw new AppError(409, 'not_draft', 'a discount is given on a draft bill; this one is ' + bill.status);
  const { rows: pendingRows } = await db.query(`SELECT COALESCE(SUM(amount_paise), 0)::text AS sum FROM discounts WHERE bill_id = $1 AND status = 'pending'`, [billId]);
  if (input.amountPaise > bill.totalPaise - Number(pendingRows[0]?.sum ?? 0)) {
    throw new AppError(422, 'validation_failed', `amountPaise: more than the bill's total of ${bill.totalPaise}`);
  }
  const { rows } = await db.query('SELECT discount_limit_paise FROM hospital LIMIT 1');
  const limit = rows[0]?.discount_limit_paise == null ? DEFAULT_DISCOUNT_LIMIT_PAISE : Number(rows[0].discount_limit_paise);
  const status = input.amountPaise > limit ? 'pending' : 'applied';
  return withTransaction(db, async (tx) => {
    if (status === 'applied') await applyToBill(tx, bill, input.amountPaise, by);
    const { rows: inserted } = await tx.query(
      `INSERT INTO discounts (id, status, created_by, updated_by, bill_id, amount_paise, reason) VALUES ($1, $2, $3, $3, $4, $5, $6) RETURNING *`,
      [randomUUID(), status, by, billId, input.amountPaise, input.reason],
    );
    return toDiscount(inserted[0] as Record<string, unknown>);
  });
}
