import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import type { BaseFields } from '../patients/patients.js';
import { toPrescription } from '../prescriptions/prescriptions.js';
import type { Admission } from './admissions.js';

// Medication administration record (api-list.md MarEntry). The schedule is every line of the stay's confirmed (or
// dispensed) prescriptions; the nurse records each dose against a line (#73). Draft uploads are not on it until confirmed.

export const MAR_OUTCOMES = ['given', 'held', 'refused'] as const;
export type MarOutcome = (typeof MAR_OUTCOMES)[number];

export interface MarEntry extends BaseFields {
  admissionId: string;
  prescriptionId: string;
  lineIndex: number;
  at: string;
  outcome: MarOutcome;
  dose?: string;
  note?: string;
}

export function toMarEntry(r: Record<string, unknown>): MarEntry {
  return {
    ...baseFields(r as unknown as BaseRow),
    admissionId: String(r.admission_id),
    prescriptionId: String(r.prescription_id),
    lineIndex: Number(r.line_index),
    at: (r.at as Date).toISOString(),
    outcome: r.outcome as MarOutcome,
    ...(r.dose != null && { dose: String(r.dose) }),
    ...(r.note != null && { note: String(r.note) }),
  };
}

export interface MarLine {
  prescriptionId: string;
  lineIndex: number;
  drugText: string;
  dose: string;
  frequency: string;
}

/** The lines the ward gives during this stay. */
export async function marSchedule(db: Queryable, admission: Admission): Promise<MarLine[]> {
  const { rows } = await db.query(
    "SELECT * FROM prescriptions WHERE encounter_id = $1 AND status IN ('confirmed', 'dispensed') ORDER BY created_at, id",
    [admission.encounterId],
  );
  return rows.map(toPrescription).flatMap((p) =>
    p.lines.map((line, lineIndex) => ({ prescriptionId: p.id, lineIndex, drugText: line.drugText, dose: line.dose, frequency: line.frequency })),
  );
}

/** #72: the schedule and one India day's entries (today if no date), in time order. */
export async function marDay(db: Queryable, admission: Admission, date?: string, now = new Date()) {
  const start = indiaDayStart(date ?? indiaDate(now));
  const { rows } = await db.query(
    'SELECT * FROM mar_entries WHERE admission_id = $1 AND at >= $2 AND at < $3 AND voided_at IS NULL ORDER BY at, id',
    [admission.id, start, new Date(start.getTime() + 86_400_000)],
  );
  return { schedule: await marSchedule(db, admission), entries: rows.map(toMarEntry) };
}

export interface NewMarEntry {
  prescriptionId: string;
  lineIndex: number;
  at?: string;
  outcome: MarOutcome;
  dose?: string;
  note?: string;
}

/** #73: only while admitted, against a line on the schedule, at a time during the stay. */
export async function recordMar(db: Queryable, admission: Admission, input: NewMarEntry, by: string, now = new Date()): Promise<MarEntry> {
  if (admission.status !== 'current') throw new AppError(409, 'discharged', 'this patient has been discharged');
  const schedule = await marSchedule(db, admission);
  if (!schedule.some((l) => l.prescriptionId === input.prescriptionId && l.lineIndex === input.lineIndex)) {
    throw new AppError(422, 'invalid_input', "prescriptionId / lineIndex: not a line of this stay's prescriptions");
  }
  const at = input.at ? new Date(input.at) : now;
  if (at.getTime() > now.getTime() + 5 * 60_000) throw new AppError(422, 'invalid_input', 'at: this time has not come yet');
  if (at < new Date(admission.admittedAt)) throw new AppError(422, 'invalid_input', 'at: before the admission');
  const { rows } = await db.query(
    `INSERT INTO mar_entries (id, status, created_by, updated_by, admission_id, patient_id, prescription_id, line_index, at, outcome, dose, note)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      randomUUID(), by, admission.id, admission.patientId, input.prescriptionId, input.lineIndex, at, input.outcome,
      input.dose ?? null, input.note ?? null,
    ],
  );
  return toMarEntry(rows[0] as Record<string, unknown>);
}
