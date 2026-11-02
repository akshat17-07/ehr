import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';

// Dental chart (api-list.md DentalEntry): what was found and done on each tooth, oldest first. Teeth are FDI numbers:
// 11-18, 21-28, 31-38, 41-48 (permanent) and 51-55, 61-65, 71-75, 81-85 (milk teeth).

export const FDI_TOOTH = /^([1-4][1-8]|[5-8][1-5])$/;
/** Surfaces: Mesial, Distal, Occlusal, Buccal, Lingual, Incisal, Palatal (one or more letters). */
export const TOOTH_SURFACES = /^[MDOBLIP]{1,5}$/;

export interface DentalEntry extends BaseFields {
  patientId: string;
  encounterId?: string;
  tooth: string;
  surface?: string;
  condition: string;
  treatment?: string;
  at: string;
}

export function toDentalEntry(r: Record<string, unknown>): DentalEntry {
  return {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    ...(r.encounter_id != null && { encounterId: String(r.encounter_id) }),
    tooth: String(r.tooth),
    ...(r.surface != null && { surface: String(r.surface) }),
    condition: String(r.condition),
    ...(r.treatment != null && { treatment: String(r.treatment) }),
    at: (r.at as Date).toISOString(),
  };
}

/** #77: every tooth with an entry, each tooth's entries oldest first. */
export async function dentalChart(db: Queryable, patientId: string): Promise<{ teeth: Record<string, DentalEntry[]> }> {
  const { rows } = await db.query('SELECT * FROM dental_entries WHERE patient_id = $1 AND voided_at IS NULL ORDER BY at, id', [patientId]);
  const teeth: Record<string, DentalEntry[]> = {};
  for (const entry of rows.map(toDentalEntry)) (teeth[entry.tooth] ??= []).push(entry);
  return { teeth };
}

/** 422 unless the encounter is one of this patient's. */
export async function assertPatientEncounter(db: Queryable, patientId: string, encounterId: string): Promise<void> {
  const { rows } = await db.query('SELECT patient_id FROM encounters WHERE id = $1', [encounterId]);
  if (rows[0]?.patient_id !== patientId) throw new AppError(422, 'invalid_input', "encounterId: not one of this patient's encounters");
}

export interface NewDentalEntry {
  tooth: string;
  surface?: string;
  condition: string;
  treatment?: string;
}

/** #78: several teeth at one sitting, saved together. */
export async function addDentalEntries(
  db: Queryable,
  patientId: string,
  input: { encounterId?: string; entries: NewDentalEntry[] },
  by: string,
  now = new Date(),
): Promise<DentalEntry[]> {
  if (input.encounterId) await assertPatientEncounter(db, patientId, input.encounterId);
  return withTransaction(db, async (tx) => {
    const saved: DentalEntry[] = [];
    for (const e of input.entries) {
      const { rows } = await tx.query(
        `INSERT INTO dental_entries (id, status, created_by, updated_by, patient_id, encounter_id, tooth, surface, condition, treatment, at)
         VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [randomUUID(), by, patientId, input.encounterId ?? null, e.tooth, e.surface ?? null, e.condition, e.treatment ?? null, now],
      );
      saved.push(toDentalEntry(rows[0] as Record<string, unknown>));
    }
    return saved;
  });
}
