import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { getPatient, type BaseFields } from './patients.js';

// Allergies (api-list.md Allergy): what the patient reacts to, with how badly. drugId links a drug from the drug
// list, so prescribing can warn. The patient's `allergies` (the banner list) is kept to the active substances.

export const ALLERGY_SEVERITIES = ['mild', 'moderate', 'severe'] as const;
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number];

export interface Allergy extends BaseFields {
  patientId: string;
  substance: string;
  drugId?: string;
  reaction?: string;
  severity: AllergySeverity;
}

export function toAllergy(r: Record<string, unknown>): Allergy {
  return {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    substance: String(r.substance),
    ...(r.drug_id != null && { drugId: String(r.drug_id) }),
    ...(r.reaction != null && { reaction: String(r.reaction) }),
    severity: r.severity as AllergySeverity,
  };
}

/** #52: a patient's allergies, oldest first; voided ones only when asked. */
export async function listAllergies(db: Queryable, patientId: string, includeVoid = false): Promise<Allergy[]> {
  const { rows } = await db.query(
    `SELECT * FROM allergies WHERE patient_id = $1${includeVoid ? '' : ' AND voided_at IS NULL'} ORDER BY created_at, id`,
    [patientId],
  );
  return rows.map(toAllergy);
}

/** Sets the patient's banner list to the active substances (system-kept, like last_activity_at: no new version). */
export async function refreshAllergyList(db: Queryable, patientId: string): Promise<void> {
  const active = await listAllergies(db, patientId);
  await db.query('UPDATE patients SET allergies = $2 WHERE id = $1', [patientId, JSON.stringify(active.map((a) => a.substance))]);
}

export interface NewAllergy {
  substance: string;
  drugId?: string;
  reaction?: string;
  severity: AllergySeverity;
}

/** #53: 422 for a drug not in the drug list; 409 if the substance is already recorded. */
export async function addAllergy(db: Queryable, patientId: string, input: NewAllergy, by: string): Promise<Allergy> {
  const patient = await getPatient(db, patientId);
  if (input.drugId) {
    const drug = await db.query('SELECT 1 FROM drugs WHERE id = $1', [input.drugId]);
    if (!drug.rows[0]) throw new AppError(422, 'invalid_input', 'drugId: no such drug');
  }
  const known = await listAllergies(db, patient.id);
  if (known.some((a) => a.substance.toLowerCase() === input.substance.toLowerCase())) {
    throw new AppError(409, 'already_recorded', 'this allergy is already recorded');
  }
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO allergies (id, status, created_by, updated_by, patient_id, substance, drug_id, reaction, severity)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [randomUUID(), by, patient.id, input.substance, input.drugId ?? null, input.reaction ?? null, input.severity],
    );
    await refreshAllergyList(tx, patient.id);
    return toAllergy(rows[0] as Record<string, unknown>);
  });
}
