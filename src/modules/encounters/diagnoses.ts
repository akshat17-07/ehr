import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';
import { assertOpen, getEncounter } from './encounters.js';

// Diagnoses (api-list.md Diagnosis): an ICD-10 code from the code list, with the doctor's own wording, provisional
// until confirmed. A wrong one is voided with a reason (#51), never deleted.

export const DIAGNOSIS_KINDS = ['provisional', 'final'] as const;
export type DiagnosisKind = (typeof DIAGNOSIS_KINDS)[number];

export interface Diagnosis extends BaseFields {
  encounterId: string;
  patientId: string;
  icd10: string;
  text: string;
  kind: DiagnosisKind;
}

export function toDiagnosis(r: Record<string, unknown>): Diagnosis {
  return {
    ...baseFields(r as unknown as BaseRow),
    encounterId: String(r.encounter_id),
    patientId: String(r.patient_id),
    icd10: String(r.icd10),
    text: String(r.text),
    kind: r.kind as DiagnosisKind,
  };
}

export interface NewDiagnosis {
  icd10: string;
  text: string;
  kind: DiagnosisKind;
}

/** #50: 422 for a code not in the ICD-10 list. */
export async function addDiagnosis(db: Queryable, encounterId: string, input: NewDiagnosis, by: string): Promise<Diagnosis> {
  const encounter = await getEncounter(db, encounterId);
  assertOpen(encounter);
  const icd10 = input.icd10.toUpperCase();
  const code = await db.query("SELECT 1 FROM codes WHERE system = 'icd10' AND code = $1 AND status = 'active'", [icd10]);
  if (!code.rows[0]) throw new AppError(422, 'invalid_input', 'icd10: not in the code list');
  const { rows } = await db.query(
    `INSERT INTO diagnoses (id, status, created_by, updated_by, encounter_id, patient_id, icd10, text, kind)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [randomUUID(), by, encounter.id, encounter.patientId, icd10, input.text, input.kind],
  );
  return toDiagnosis(rows[0] as Record<string, unknown>);
}

/** The diagnoses of one encounter, oldest first (for #38); voided ones are left out. */
export async function encounterDiagnoses(db: Queryable, encounterId: string): Promise<Diagnosis[]> {
  const { rows } = await db.query('SELECT * FROM diagnoses WHERE encounter_id = $1 AND voided_at IS NULL ORDER BY created_at, id', [
    encounterId,
  ]);
  return rows.map(toDiagnosis);
}
