import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
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
