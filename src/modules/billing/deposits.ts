import { randomUUID } from 'node:crypto';
import { withGapFreeCount } from '../../db/counters.js';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { indiaDate } from '../../time/india.js';
import { financialYear } from '../pharmacy/bills.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { assertCashLimit } from './payments.js';

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
