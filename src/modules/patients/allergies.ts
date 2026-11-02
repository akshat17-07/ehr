import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from './patients.js';

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
