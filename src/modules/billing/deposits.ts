import { randomUUID } from 'node:crypto';
import { withGapFreeCount } from '../../db/counters.js';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { indiaDate } from '../../time/india.js';
import { financialYear } from '../pharmacy/bills.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { UUID } from '../users/users.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { getBill, type Bill } from './bills.js';
import { addPayment, assertCashLimit } from './payments.js';

// Advance deposits (api-list.md Deposit): money taken before the bill, used on bills later (#128).

export const DEPOSIT_MODES = ['cash', 'upi', 'card'] as const;
export type DepositMode = (typeof DEPOSIT_MODES)[number];

export interface Deposit extends BaseFields {
  patientId: string;
  receiptNo: string;
  amountPaise: number;
  /** What is left to use on bills or refund. */
  balancePaise: number;
  mode: DepositMode;
  reference?: string;
  receivedBy: string;
}

export function toDeposit(r: Record<string, unknown>): Deposit {
  const base = baseFields(r as unknown as BaseRow);
  return {
    ...base,
    patientId: String(r.patient_id),
    receiptNo: String(r.receipt_no),
    amountPaise: Number(r.amount_paise),
    balancePaise: Number(r.balance_paise),
    mode: r.mode as DepositMode,
    ...(r.reference != null && { reference: String(r.reference) }),
    receivedBy: base.createdBy,
  };
}

/** #126: 404 for no patient; 422 cash_limit (sec 269ST). The receipt number is `DEP/<yy-yy>/<n>`, with no gaps. */
export async function takeDeposit(
  db: Queryable,
  patientId: string,
  input: { amountPaise: number; mode: DepositMode; reference?: string },
  by: string,
  now = new Date(),
): Promise<Deposit> {
  const patient = await getPatient(db, patientId);
  if (input.mode === 'cash') await assertCashLimit(db, patient.id, undefined, input.amountPaise, now);
  const year = financialYear(indiaDate(now));
  return withGapFreeCount(db, `deposit-${year}`, async (tx, n) => {
    const { rows } = await tx.query(
      `INSERT INTO deposits (id, status, created_by, updated_by, patient_id, receipt_no, amount_paise, balance_paise, mode, reference)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $5, $6, $7) RETURNING *`,
      [randomUUID(), by, patient.id, `DEP/${year}/${n}`, input.amountPaise, input.mode, input.reference ?? null],
    );
    return toDeposit(rows[0] as Record<string, unknown>);
  });
}

/** #127: the patient's deposits, newest first (404 for no patient). */
export async function patientDeposits(db: Queryable, patientId: string): Promise<Deposit[]> {
  const patient = await getPatient(db, patientId);
  const { rows } = await db.query('SELECT * FROM deposits WHERE patient_id = $1 ORDER BY created_at DESC, id DESC', [patient.id]);
  return rows.map(toDeposit);
}

/** 404 for no deposit (or not a UUID). */
export async function getDeposit(db: Queryable, id: string): Promise<Deposit> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM deposits WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such deposit');
  return toDeposit(rows[0] as Record<string, unknown>);
}

/**
 * #128: uses part of a deposit to pay a bill of the same patient (a payment in mode deposit).
 * 409 voided; 409 not_payable unless the bill is final or part paid; 422 for another patient's bill,
 * or for more than the deposit's balance or the bill's due.
 */
export async function applyDeposit(db: Queryable, id: string, input: { billId: string; amountPaise: number }, by: string): Promise<{ deposit: Deposit; bill: Bill }> {
  const deposit = await getDeposit(db, id);
  if (deposit.status === 'void') throw new AppError(409, 'voided', 'this deposit is voided');
  const bill = await getBill(db, input.billId).catch((error: unknown) => {
    if (error instanceof AppError && error.status === 404) throw new AppError(422, 'validation_failed', 'billId: no such bill');
    throw error;
  });
  if (bill.patientId !== deposit.patientId) throw new AppError(422, 'validation_failed', "billId: the bill is another patient's");
  if (bill.status !== 'final' && bill.status !== 'part_paid') throw new AppError(409, 'not_payable', 'a bill is paid once final; this one is ' + bill.status);
  if (input.amountPaise > deposit.balancePaise) throw new AppError(422, 'validation_failed', `amountPaise: more than the ${deposit.balancePaise} left on the deposit`);
  if (input.amountPaise > bill.duePaise) throw new AppError(422, 'validation_failed', `amountPaise: more than the ${bill.duePaise} due`);
  return withTransaction(db, async (tx) => {
    const row = await updateRecord(tx, 'deposits', { id, version: deposit.version, by, set: { balance_paise: deposit.balancePaise - input.amountPaise } });
    const paid = await addPayment(tx, bill, { amountPaise: input.amountPaise, mode: 'deposit', depositId: id }, by);
    return { deposit: toDeposit(row), bill: paid.bill };
  });
}
