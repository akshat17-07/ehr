import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDayStart } from '../../time/india.js';
import type { BaseFields } from '../patients/patients.js';
import { assertOpen, getEncounter } from './encounters.js';

// Vitals (api-list.md Vital): one set of readings taken at one time, in an open encounter. Any of the values may be
// missing, but not all. Kept as recorded: a wrong reading is voided, not changed.

/** API field, database column, and the range a real reading falls in (anything outside is a typing slip). */
export const VITAL_FIELDS = [
  ['bpSys', 'bp_sys', 50, 300],
  ['bpDia', 'bp_dia', 20, 200],
  ['pulse', 'pulse', 20, 250],
  ['tempC', 'temp_c', 30, 45],
  ['spo2', 'spo2', 50, 100],
  ['respRate', 'resp_rate', 4, 80],
  ['weightKg', 'weight_kg', 0.3, 400],
  ['heightCm', 'height_cm', 20, 250],
  ['bloodSugarMgDl', 'blood_sugar_mg_dl', 10, 1000],
] as const;
export type VitalField = (typeof VITAL_FIELDS)[number][0];
export type VitalValues = Partial<Record<VitalField, number>>;

export interface Vital extends BaseFields, VitalValues {
  encounterId: string;
  patientId: string;
  takenAt: string;
}

export function toVital(r: Record<string, unknown>): Vital {
  const vital: Vital = {
    ...baseFields(r as unknown as BaseRow),
    encounterId: String(r.encounter_id),
    patientId: String(r.patient_id),
    takenAt: (r.taken_at as Date).toISOString(),
  };
  for (const [field, column] of VITAL_FIELDS) if (r[column] != null) vital[field] = Number(r[column]);
  return vital;
}

export interface NewVital extends VitalValues {
  takenAt?: string;
}

/** #41 */
export async function recordVital(db: Queryable, encounterId: string, input: NewVital, by: string, now = new Date()): Promise<Vital> {
  const encounter = await getEncounter(db, encounterId);
  assertOpen(encounter);
  const takenAt = input.takenAt ? new Date(input.takenAt) : now;
  if (takenAt.getTime() > now.getTime() + 5 * 60_000) throw new AppError(422, 'invalid_input', 'takenAt: this time has not come yet');

  const columns = VITAL_FIELDS.filter(([field]) => input[field] !== undefined);
  const values = columns.map(([field]) => input[field]);
  const { rows } = await db.query(
    `INSERT INTO vitals (id, status, created_by, updated_by, encounter_id, patient_id, taken_at${columns.map(([, c]) => `, ${c}`).join('')})
     VALUES ($1, 'active', $2, $2, $3, $4, $5${columns.map((_, i) => `, $${i + 6}`).join('')}) RETURNING *`,
    [randomUUID(), by, encounter.id, encounter.patientId, takenAt, ...values],
  );
  return toVital(rows[0] as Record<string, unknown>);
}

/** The vitals of one encounter, oldest first (for #38). */
export async function encounterVitals(db: Queryable, encounterId: string): Promise<Vital[]> {
  const { rows } = await db.query('SELECT * FROM vitals WHERE encounter_id = $1 AND voided_at IS NULL ORDER BY taken_at, id', [encounterId]);
  return rows.map(toVital);
}

export interface VitalsQuery extends PageQuery {
  /** India dates, YYYY-MM-DD, both days included. */
  from?: string;
  to?: string;
}

/** #42: a patient's vitals across encounters, newest first (for trends). */
export async function patientVitals(db: Queryable, patientId: string, query: VitalsQuery): Promise<Page<Vital>> {
  const params: unknown[] = [patientId];
  const where = ['patient_id = $1', 'voided_at IS NULL'];
  if (query.from) where.push(`taken_at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`taken_at < $${params.push(new Date(indiaDayStart(query.to).getTime() + 86_400_000))}`);
  return pageRows(db, { select: 'SELECT * FROM vitals', where, params, orderBy: ['taken_at', 'id'] }, query, toVital);
}
