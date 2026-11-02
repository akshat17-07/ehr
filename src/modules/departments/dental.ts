import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from '../patients/patients.js';

// Dental chart (api-list.md DentalEntry): what was found and done on each tooth, oldest first. Teeth are FDI numbers:
// 11-18, 21-28, 31-38, 41-48 (permanent) and 51-55, 61-65, 71-75, 81-85 (milk teeth).

export const FDI_TOOTH = /^([1-4][1-8]|[5-8][1-5])$/;

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
