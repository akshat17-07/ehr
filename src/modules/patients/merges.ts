import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { getPatient, type BaseFields } from './patients.js';

// Merging duplicate patients (api-list.md PatientMerge): one person proposes (#28), a second approves (#181) or
// rejects (#182). Only on approval do records move to the kept UHID; until then nothing changes.
// status: pending / approved / rejected.

export interface PatientMerge extends BaseFields {
  keepPatientId: string;
  mergePatientId: string;
  reason: string;
  proposedBy: string;
  approvedBy?: string;
}

export interface NewMerge {
  keepPatientId: string;
  mergePatientId: string;
  reason: string;
}

export function toMerge(r: Record<string, unknown>): PatientMerge {
  return {
    ...baseFields(r as unknown as BaseRow),
    keepPatientId: String(r.keep_patient_id),
    mergePatientId: String(r.merge_patient_id),
    reason: String(r.reason),
    proposedBy: String(r.proposed_by),
    ...(r.approved_by != null && { approvedBy: String(r.approved_by) }),
  };
}

const invalid = (message: string) => new AppError(422, 'invalid_input', message);

/** #28: proposes merging `mergePatientId` into `keepPatientId`. 409 if either is merged or already in a pending merge. */
export async function proposeMerge(db: Queryable, input: NewMerge, by: string): Promise<PatientMerge> {
  if (input.keepPatientId === input.mergePatientId) throw invalid('choose two different patients');
  for (const [field, id] of [['keepPatientId', input.keepPatientId], ['mergePatientId', input.mergePatientId]] as const) {
    await getPatient(db, id).catch(() => {
      throw invalid(`${field}: no such patient`);
    });
  }
  const ids = [input.keepPatientId, input.mergePatientId];
  const merged = await db.query('SELECT uhid FROM patients WHERE id IN ($1, $2) AND merged_into IS NOT NULL', ids);
  if (merged.rows[0]) throw new AppError(409, 'merged', `${String(merged.rows[0].uhid)} is already merged into another patient`);
  const pending = await db.query(
    `SELECT 1 FROM patient_merges WHERE status = 'pending'
       AND (keep_patient_id IN ($1, $2) OR merge_patient_id IN ($1, $2))`,
    ids,
  );
  if (pending.rows[0]) throw new AppError(409, 'merge_pending', 'one of these patients is already in a merge waiting for approval');

  const { rows } = await db.query(
    `INSERT INTO patient_merges (id, status, created_by, updated_by, keep_patient_id, merge_patient_id, reason, proposed_by)
     VALUES ($1, 'pending', $2, $2, $3, $4, $5, $2) RETURNING *`,
    [randomUUID(), by, input.keepPatientId, input.mergePatientId, input.reason],
  );
  return toMerge(rows[0] as Record<string, unknown>);
}
