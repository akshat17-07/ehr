import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDayStart } from '../../time/india.js';
import type { BaseFields } from '../patients/patients.js';
import { assertOpen, getEncounter } from './encounters.js';

// Observations (api-list.md Observation): one LOINC-coded reading outside the fixed vitals (pain score, GCS, a bedside
// test). The value is a number or text; numbers are kept apart so they can be charted. Voided, never changed.

export interface Observation extends BaseFields {
  encounterId: string;
  patientId: string;
  loinc: string;
  name: string;
  value: string | number;
  unit?: string;
  takenAt: string;
}

export function toObservation(r: Record<string, unknown>): Observation {
  return {
    ...baseFields(r as unknown as BaseRow),
    encounterId: String(r.encounter_id),
    patientId: String(r.patient_id),
    loinc: String(r.loinc),
    name: String(r.name),
    value: r.value_num != null ? Number(r.value_num) : String(r.value_text),
    ...(r.unit != null && { unit: String(r.unit) }),
    takenAt: (r.taken_at as Date).toISOString(),
  };
}

export interface NewObservation {
  loinc: string;
  name: string;
  value: string | number;
  unit?: string;
  takenAt?: string;
}

/** #43: 422 for a LOINC code not in the code list. */
export async function recordObservation(
  db: Queryable,
  encounterId: string,
  input: NewObservation,
  by: string,
  now = new Date(),
): Promise<Observation> {
  const encounter = await getEncounter(db, encounterId);
  assertOpen(encounter);
  const invalid = (message: string) => new AppError(422, 'invalid_input', message);
  const takenAt = input.takenAt ? new Date(input.takenAt) : now;
  if (takenAt.getTime() > now.getTime() + 5 * 60_000) throw invalid('takenAt: this time has not come yet');
  const code = await db.query("SELECT 1 FROM codes WHERE system = 'loinc' AND code = $1 AND status = 'active'", [input.loinc]);
  if (!code.rows[0]) throw invalid('loinc: not in the code list');

  const numeric = typeof input.value === 'number';
  const { rows } = await db.query(
    `INSERT INTO observations (id, status, created_by, updated_by, encounter_id, patient_id, loinc, name, value_num, value_text, unit, taken_at)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      randomUUID(),
      by,
      encounter.id,
      encounter.patientId,
      input.loinc,
      input.name,
      numeric ? input.value : null,
      numeric ? null : input.value,
      input.unit ?? null,
      takenAt,
    ],
  );
  return toObservation(rows[0] as Record<string, unknown>);
}

export interface ObservationsQuery extends PageQuery {
  loinc?: string;
  /** India dates, YYYY-MM-DD, both days included. */
  from?: string;
  to?: string;
}

/** #44: a patient's observations, newest first; with `loinc`, one measure over time. */
export async function patientObservations(db: Queryable, patientId: string, query: ObservationsQuery): Promise<Page<Observation>> {
  const params: unknown[] = [patientId];
  const where = ['patient_id = $1', 'voided_at IS NULL'];
  if (query.loinc) where.push(`loinc = $${params.push(query.loinc)}`);
  if (query.from) where.push(`taken_at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`taken_at < $${params.push(new Date(indiaDayStart(query.to).getTime() + 86_400_000))}`);
  return pageRows(db, { select: 'SELECT * FROM observations', where, params, orderBy: ['taken_at', 'id'] }, query, toObservation);
}
