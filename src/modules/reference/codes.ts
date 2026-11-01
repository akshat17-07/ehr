import type { Queryable } from '../../db/migrate.js';
import { seedId, seedInsert } from '../../db/table.js';

// Code lists (api-list.md Code): ICD-10 for diagnoses and LOINC for observations, in one table by `system`.
// The vital signs below are built in. The full lists are loaded from the WHO ICD-10 and LOINC tables.
// LOINC content: Copyright © Regenstrief Institute, Inc. and the LOINC Committee, used under the LOINC licence (loinc.org/license).

export const CODE_SYSTEMS = ['icd10', 'loinc'] as const;
export type CodeSystem = (typeof CODE_SYSTEMS)[number];

export interface Code {
  code: string;
  text: string;
}

/** The LOINC codes the vitals screen records (api-list.md Observation). */
export const VITAL_SIGNS: readonly Code[] = [
  { code: '8867-4', text: 'Heart rate' },
  { code: '9279-1', text: 'Respiratory rate' },
  { code: '8310-5', text: 'Body temperature' },
  { code: '8480-6', text: 'Systolic blood pressure' },
  { code: '8462-4', text: 'Diastolic blood pressure' },
  { code: '59408-5', text: 'Oxygen saturation in arterial blood by pulse oximetry' },
  { code: '29463-7', text: 'Body weight' },
  { code: '8302-2', text: 'Body height' },
  { code: '39156-5', text: 'Body mass index (BMI) [Ratio]' },
  { code: '2339-0', text: 'Glucose [Mass/volume] in blood' },
];

/** The INSERTs for the built-in vital signs. */
export function seedVitalSigns(): string[] {
  return VITAL_SIGNS.map((c, i) => seedInsert('codes', seedId('c0de0000', i + 1), { system: 'loinc', code: c.code, text: c.text }));
}

/** #17/#18: codes whose code starts with `q` (dots ignored), then codes whose text has it. */
export async function searchCodes(db: Queryable, system: CodeSystem, search: { q: string; limit?: number }): Promise<Code[]> {
  const q = search.q.replace(/[\\%_]/g, '\\$&');
  const prefix = `${q.replaceAll('.', '').toUpperCase()}%`;
  const { rows } = await db.query(
    `SELECT code, text FROM codes
     WHERE system = $1 AND (replace(code, '.', '') LIKE $2 OR lower(text) LIKE $3)
     ORDER BY (replace(code, '.', '') LIKE $2) DESC, code
     LIMIT $4`,
    [system, prefix, `%${q.toLowerCase()}%`, search.limit ?? 20],
  );
  return rows.map((r) => ({ code: String(r.code), text: String(r.text) }));
}
