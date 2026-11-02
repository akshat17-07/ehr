import type { Queryable } from '../../db/migrate.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { patientSummaries, type PatientSummary } from '../patients/patients.js';
import { toPrescription, type Prescription } from '../prescriptions/prescriptions.js';

// The pharmacy counter's work list. A prescription leaves it once fully dispensed (status dispensed, #101).

export const SETTINGS = ['opd', 'ipd'] as const;
export type Setting = (typeof SETTINGS)[number];

export interface QueuedPrescription extends Prescription {
  setting: Setting;
  patient: PatientSummary;
}

/**
 * #100: the prescriptions confirmed on one IST day (today by default) and not yet fully dispensed, oldest first.
 * IPD encounters are ipd; OPD and ER are opd.
 */
export async function pharmacyQueue(db: Queryable, query: { date?: string; setting?: Setting }, now = new Date()): Promise<QueuedPrescription[]> {
  const start = indiaDayStart(query.date ?? indiaDate(now));
  const where = ["p.status = 'confirmed'", 'p.confirmed_at >= $1', 'p.confirmed_at < $2'];
  if (query.setting) where.push(query.setting === 'ipd' ? "e.type = 'IPD'" : "e.type <> 'IPD'");
  const { rows } = await db.query(
    `SELECT p.*, e.type AS encounter_type FROM prescriptions p JOIN encounters e ON e.id = p.encounter_id
     WHERE ${where.join(' AND ')} ORDER BY p.confirmed_at, p.id`,
    [start, new Date(start.getTime() + 86_400_000)],
  );
  const patients = await patientSummaries(db, rows.map((r) => String(r.patient_id)), now);
  return rows.map((r) => {
    const prescription = toPrescription(r as Record<string, unknown>);
    return {
      ...prescription,
      setting: r.encounter_type === 'IPD' ? 'ipd' : 'opd',
      patient: patients.get(prescription.patientId) as PatientSummary,
    };
  });
}
