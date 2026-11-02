import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import { assertOpen, getEncounter } from '../encounters/encounters.js';
import type { BaseFields } from '../patients/patients.js';
import type { RxLine } from '../prescriptions/rx-checks.js';

// Discharge summaries (api-list.md DischargeSummary): written as a draft on the IPD encounter (#74), edited (#75),
// then signed (#76), which discharges the patient. Unpaid dues never block discharge.

export const DISCHARGE_STATUSES = ['draft', 'signed'] as const;
export type DischargeStatus = (typeof DISCHARGE_STATUSES)[number];

export interface DischargeSummary extends Omit<BaseFields, 'status'> {
  status: DischargeStatus;
  encounterId: string;
  patientId: string;
  diagnosisText: string;
  course: string;
  procedures?: string;
  medicinesOnDischarge: RxLine[];
  advice: string;
  /** YYYY-MM-DD. */
  followUpDate?: string;
  signedAt?: string;
  signedBy?: string;
}

export const SUMMARY_SELECT = 'SELECT discharge_summaries.*, follow_up_date::text AS follow_up_text FROM discharge_summaries';

export function toDischargeSummary(r: Record<string, unknown>): DischargeSummary {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as DischargeStatus,
    encounterId: String(r.encounter_id),
    patientId: String(r.patient_id),
    diagnosisText: String(r.diagnosis_text),
    course: String(r.course),
    ...(r.procedures != null && { procedures: String(r.procedures) }),
    medicinesOnDischarge: JSON.parse(String(r.medicines)) as RxLine[],
    advice: String(r.advice),
    ...(r.follow_up_text != null && { followUpDate: String(r.follow_up_text) }),
    ...(r.signed_at != null && { signedAt: (r.signed_at as Date).toISOString() }),
    ...(r.signed_by != null && { signedBy: String(r.signed_by) }),
  };
}

export interface SummaryFields {
  diagnosisText: string;
  course: string;
  procedures?: string;
  medicinesOnDischarge: RxLine[];
  advice: string;
  followUpDate?: string;
}

/** 422 for a follow-up date already past. */
export function checkFollowUp(followUpDate: string | undefined, now: Date): void {
  if (followUpDate && followUpDate < indiaDate(now)) throw new AppError(422, 'invalid_input', 'followUpDate: already past');
}

/** #74: on an open IPD encounter; 409 if it already has one. */
export async function writeSummary(db: Queryable, encounterId: string, input: SummaryFields, by: string, now = new Date()): Promise<DischargeSummary> {
  const encounter = await getEncounter(db, encounterId);
  assertOpen(encounter);
  if (encounter.type !== 'IPD') throw new AppError(422, 'invalid_input', 'a discharge summary is for an IPD stay');
  checkFollowUp(input.followUpDate, now);
  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO discharge_summaries (id, status, created_by, updated_by, encounter_id, patient_id, diagnosis_text, course, procedures,
         medicines, advice, follow_up_date)
       VALUES ($1, 'draft', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id, by, encounter.id, encounter.patientId, input.diagnosisText, input.course, input.procedures ?? null,
        JSON.stringify(input.medicinesOnDischarge), input.advice, input.followUpDate ?? null,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new AppError(409, 'already_written', 'this stay already has a discharge summary');
    throw error;
  }
  const { rows } = await db.query(`${SUMMARY_SELECT} WHERE id = $1`, [id]);
  return toDischargeSummary(rows[0] as Record<string, unknown>);
}
