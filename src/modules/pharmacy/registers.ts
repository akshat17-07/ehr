import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { patientSummaries } from '../patients/patients.js';
import type { DispenseLine } from './dispenses.js';

// Statutory drug registers (api-list.md RegisterRow), read from the dispenses: one row per dispensed line of a drug
// in the register's schedule, oldest first. Nothing is kept twice; the register is printed from here.

export const REGISTERS = { h1: ['H1'] } as const;
export type RegisterKind = keyof typeof REGISTERS;

export interface RegisterRow {
  date: string;
  at: string;
  dispenseId: string;
  patientId: string;
  patientName: string;
  uhid?: string;
  prescriber: string;
  prescriberRegNo: string;
  drug: string;
  schedule: string;
  batchNo: string;
  qty: number;
  /** Brought back later (#103). */
  returnedQty: number;
  pharmacist: string;
}

/** The longest period one print covers. */
const MAX_DAYS = 366;

/** #113: 422 if to is before from or the period is over a year. */
export async function drugRegister(db: Queryable, kind: RegisterKind, query: { from: string; to: string }, now = new Date()): Promise<RegisterRow[]> {
  const start = indiaDayStart(query.from);
  const end = new Date(indiaDayStart(query.to).getTime() + 86_400_000);
  if (end <= start) throw new AppError(422, 'validation_failed', 'to: before from');
  if (end.getTime() - start.getTime() > MAX_DAYS * 86_400_000) throw new AppError(422, 'validation_failed', `to: at most ${MAX_DAYS} days after from`);
  const { rows } = await db.query(
    `SELECT d.id, d.patient_id, d.lines, d.dispensed_at, u.name AS pharmacist FROM dispenses d LEFT JOIN users u ON u.id = d.pharmacist_id
     WHERE d.voided_at IS NULL AND d.dispensed_at >= $1 AND d.dispensed_at < $2 ORDER BY d.dispensed_at, d.id`,
    [start, end],
  );
  const lines = rows.flatMap((r) => (JSON.parse(String(r.lines)) as DispenseLine[]).map((line) => ({ r, line })));
  const drugIds = [...new Set(lines.map(({ line }) => line.drugId))];
  if (drugIds.length === 0) return [];
  const schedules: readonly string[] = REGISTERS[kind];
  const { rows: drugRows } = await db.query(
    `SELECT id, name, schedule FROM drugs WHERE id IN (${drugIds.map((_, i) => `$${i + 1}`).join(', ')})`,
    drugIds,
  );
  const drugs = new Map(drugRows.filter((d) => schedules.includes(String(d.schedule))).map((d) => [String(d.id), d]));
  const wanted = lines.filter(({ line }) => drugs.has(line.drugId));
  if (wanted.length === 0) return [];
  const batchIds = [...new Set(wanted.map(({ line }) => line.batchId))];
  const { rows: batchRows } = await db.query(`SELECT id, batch_no FROM batches WHERE id IN (${batchIds.map((_, i) => `$${i + 1}`).join(', ')})`, batchIds);
  const batchNos = new Map(batchRows.map((b) => [String(b.id), String(b.batch_no)]));
  const patients = await patientSummaries(db, wanted.map(({ r }) => String(r.patient_id)), now);
  return wanted.map(({ r, line }) => {
    const at = r.dispensed_at as Date;
    const patient = patients.get(String(r.patient_id));
    const drug = drugs.get(line.drugId);
    return {
      date: indiaDate(at),
      at: at.toISOString(),
      dispenseId: String(r.id),
      patientId: String(r.patient_id),
      patientName: patient?.name ?? '',
      ...(patient?.uhid && { uhid: patient.uhid }),
      prescriber: line.h1?.prescriberName ?? '',
      prescriberRegNo: line.h1?.prescriberRegNo ?? '',
      drug: String(drug?.name),
      schedule: String(drug?.schedule),
      batchNo: batchNos.get(line.batchId) ?? '',
      qty: line.qty,
      returnedQty: line.returnedQty ?? 0,
      pharmacist: String(r.pharmacist ?? ''),
    };
  });
}
