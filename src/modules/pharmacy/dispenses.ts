import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { applyStockTake, batchesByIds, checkStockTake } from '../inventory/batches.js';
import { UUID } from '../users/users.js';
import type { BaseFields } from '../patients/patients.js';
import { getPrescription } from '../prescriptions/prescriptions.js';
import type { RxLine } from '../prescriptions/rx-checks.js';

// Dispensing (api-list.md Dispense): a pharmacist hands over medicines against a confirmed prescription, from
// chosen batches. Stock leaves the batch; once every line is fully given, the prescription is dispensed.

export interface DispenseLine {
  lineIndex: number;
  drugId: string;
  batchId: string;
  qty: number;
  /** Brought back by the patient (#103). */
  returnedQty?: number;
  /** Schedule H1 and X register: who prescribed it. */
  h1?: { prescriberName: string; prescriberRegNo: string };
  /** NDPS register: the patient's ID proof and address. */
  ndps?: { patientIdProof: string; address: string };
}

export interface Dispense extends BaseFields {
  prescriptionId: string;
  patientId: string;
  pharmacistId: string;
  lines: DispenseLine[];
  at: string;
}

export function toDispense(r: Record<string, unknown>): Dispense {
  return {
    ...baseFields(r as unknown as BaseRow),
    prescriptionId: String(r.prescription_id),
    patientId: String(r.patient_id),
    pharmacistId: String(r.pharmacist_id),
    lines: JSON.parse(String(r.lines)) as DispenseLine[],
    at: (r.dispensed_at as Date).toISOString(),
  };
}

const invalid = (message: string) => new AppError(422, 'validation_failed', message);

/** How much of each prescription line has been given so far. */
async function givenSoFar(db: Queryable, prescriptionId: string): Promise<Map<number, number>> {
  const { rows } = await db.query('SELECT lines FROM dispenses WHERE prescription_id = $1 AND voided_at IS NULL', [prescriptionId]);
  const given = new Map<number, number>();
  for (const row of rows) {
    for (const line of JSON.parse(String(row.lines)) as DispenseLine[]) {
      given.set(line.lineIndex, (given.get(line.lineIndex) ?? 0) + line.qty - (line.returnedQty ?? 0));
    }
  }
  return given;
}

/** A line is fully given when its quantity is reached, or (no quantity written) once any is given. */
const fullyGiven = (lines: RxLine[], given: Map<number, number>) =>
  lines.every((line, i) => (given.get(i) ?? 0) >= (line.quantity ?? 1));

/**
 * #101: 403 unless the user has a pharmacist reg. no.; 409 for an unconfirmed prescription, an expired or recalled
 * batch, short stock, or more than the prescribed quantity; 422 for a line that doesn't fit the prescription, or an
 * H1/X or NDPS drug without its register details.
 */
export async function dispense(db: Queryable, input: { prescriptionId: string; lines: DispenseLine[] }, sub: string, now = new Date()): Promise<Dispense> {
  const { rows: users } = await db.query('SELECT id, pharmacist_reg_no FROM users WHERE cognito_sub = $1', [sub]);
  const pharmacist = users[0];
  if (!pharmacist?.pharmacist_reg_no) throw new AppError(403, 'not_pharmacist', 'only a registered pharmacist can dispense');

  const prescription = await getPrescription(db, input.prescriptionId);
  if (prescription.status !== 'confirmed') {
    throw new AppError(409, 'not_confirmed', 'only a confirmed prescription is dispensed; this one is ' + prescription.status);
  }

  const drugIds = [...new Set(input.lines.map((l) => l.drugId))];
  const { rows: drugRows } = await db.query(`SELECT id, schedule FROM drugs WHERE id IN (${drugIds.map((_, i) => `$${i + 1}`).join(', ')})`, drugIds);
  const schedules = new Map(drugRows.map((d) => [String(d.id), String(d.schedule)]));
  input.lines.forEach((line, i) => {
    const prescribed = prescription.lines[line.lineIndex];
    if (!prescribed) throw invalid(`lines[${i}].lineIndex: the prescription has no line ${line.lineIndex}`);
    if (prescribed.drugId && prescribed.drugId !== line.drugId) throw invalid(`lines[${i}].drugId: not the prescribed drug`);
    const schedule = schedules.get(line.drugId);
    if (!schedule) throw invalid(`lines[${i}].drugId: no such drug`);
    if ((schedule === 'H1' || schedule === 'X') && !line.h1) throw invalid(`lines[${i}].h1: the prescriber's name and reg. no. are needed for a Schedule ${schedule} drug`);
    if (schedule === 'NDPS' && !line.ndps) throw invalid(`lines[${i}].ndps: the patient's ID proof and address are needed for an NDPS drug`);
  });

  const stock = await checkStockTake(db, input.lines, now);

  const given = await givenSoFar(db, prescription.id);
  for (const line of input.lines) given.set(line.lineIndex, (given.get(line.lineIndex) ?? 0) + line.qty);
  prescription.lines.forEach((line, i) => {
    if (line.quantity !== undefined && (given.get(i) ?? 0) > line.quantity) {
      throw new AppError(409, 'over_prescribed', `line ${i}: more than the ${line.quantity} prescribed`);
    }
  });

  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO dispenses (id, status, created_by, updated_by, prescription_id, patient_id, pharmacist_id, lines, dispensed_at)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [randomUUID(), sub, prescription.id, prescription.patientId, String(pharmacist.id), JSON.stringify(input.lines), now],
    );
    await applyStockTake(tx, stock, sub);
    if (fullyGiven(prescription.lines, given)) {
      await updateRecord(tx, 'prescriptions', { id: prescription.id, version: prescription.version, by: sub, set: { status: 'dispensed' } });
    }
    return toDispense(rows[0] as Record<string, unknown>);
  });
}

/** #102: one dispense; 404 if there is none. */
export async function getDispense(db: Queryable, id: string): Promise<Dispense> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM dispenses WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such dispense');
  return toDispense(rows[0] as Record<string, unknown>);
}

export const REFUND_MODES = ['cash', 'upi', 'card', 'credit_note'] as const;
export type RefundMode = (typeof REFUND_MODES)[number];

/**
 * #103: medicines brought back. lineIndex is the position in the dispense's lines; at most what was given (less
 * earlier returns), else 409. The stock goes back to its batch and the refund is at the batch MRP. The prescription
 * is left as it is: a return doesn't put it back in the queue.
 */
export async function returnDispense(
  db: Queryable,
  id: string,
  input: { lines: { lineIndex: number; qty: number }[]; reason: string; refundMode?: RefundMode },
  by: string,
  now = new Date(),
): Promise<{ dispense: Dispense; refundPaise: number }> {
  const given = await getDispense(db, id);
  const lines = given.lines.map((l) => ({ ...l }));
  const back = new Map<string, number>();
  input.lines.forEach((r, i) => {
    const line = lines[r.lineIndex];
    if (!line) throw invalid(`lines[${i}].lineIndex: the dispense has no line ${r.lineIndex}`);
    line.returnedQty = (line.returnedQty ?? 0) + r.qty;
    if (line.returnedQty > line.qty) throw new AppError(409, 'more_than_given', `line ${r.lineIndex}: only ${line.qty - (line.returnedQty - r.qty)} left to return`);
    back.set(line.batchId, (back.get(line.batchId) ?? 0) + r.qty);
  });
  const batches = await batchesByIds(db, [...back.keys()], now);
  const returned = input.lines.map((r) => {
    const line = lines[r.lineIndex]!;
    return { lineIndex: r.lineIndex, batchId: line.batchId, qty: r.qty, refundPaise: r.qty * batches.get(line.batchId)!.mrpPaise };
  });
  const refundPaise = returned.reduce((sum, r) => sum + r.refundPaise, 0);

  return withTransaction(db, async (tx) => {
    const row = await updateRecord(tx, 'dispenses', { id, version: given.version, by, reason: input.reason, set: { lines: JSON.stringify(lines) } });
    for (const [batchId, qty] of back) {
      const batch = batches.get(batchId)!;
      await updateRecord(tx, 'batches', { id: batchId, version: batch.version, by, set: { qty_on_hand: batch.qtyOnHand + qty } });
    }
    await tx.query(
      `INSERT INTO pharmacy_returns (id, status, created_by, updated_by, dispense_id, patient_id, lines, reason, refund_paise, refund_mode)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), by, id, given.patientId, JSON.stringify(returned), input.reason, refundPaise, input.refundMode ?? 'cash'],
    );
    return { dispense: toDispense(row), refundPaise };
  });
}
