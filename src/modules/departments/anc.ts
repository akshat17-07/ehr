import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import type { BaseFields } from '../patients/patients.js';
import { assertPatientEncounter } from './dental.js';

// Antenatal care (api-list.md AncRecord): one row per ANC visit, oldest first, so the pregnancy reads as a chart.

export interface AncRecord extends BaseFields {
  patientId: string;
  encounterId?: string;
  /** Dates, YYYY-MM-DD. */
  lmp?: string;
  edd?: string;
  gravida?: number;
  para?: number;
  gestationWeeks?: number;
  /** e.g. "120/80". */
  bp?: string;
  weightKg?: number;
  fundalHeightCm?: number;
  /** Fetal heart rate, beats per minute. */
  fhr?: number;
  notes?: string;
}

export const ANC_SELECT = 'SELECT anc_records.*, lmp::text AS lmp_text, edd::text AS edd_text FROM anc_records';

const num = (v: unknown) => (v == null ? undefined : Number(v));

export function toAncRecord(r: Record<string, unknown>): AncRecord {
  const record: AncRecord = {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    ...(r.encounter_id != null && { encounterId: String(r.encounter_id) }),
    ...(r.lmp_text != null && { lmp: String(r.lmp_text) }),
    ...(r.edd_text != null && { edd: String(r.edd_text) }),
    gravida: num(r.gravida),
    para: num(r.para),
    gestationWeeks: num(r.gestation_weeks),
    ...(r.bp != null && { bp: String(r.bp) }),
    weightKg: num(r.weight_kg),
    fundalHeightCm: num(r.fundal_height_cm),
    fhr: num(r.fhr),
    ...(r.notes != null && { notes: String(r.notes) }),
  };
  for (const key of Object.keys(record) as (keyof AncRecord)[]) if (record[key] === undefined) delete record[key];
  return record;
}

/** #79: oldest visit first. */
export async function listAncRecords(db: Queryable, patientId: string): Promise<AncRecord[]> {
  const { rows } = await db.query(`${ANC_SELECT} WHERE patient_id = $1 AND voided_at IS NULL ORDER BY created_at, id`, [patientId]);
  return rows.map(toAncRecord);
}

export type NewAncRecord = Omit<AncRecord, keyof BaseFields | 'patientId'>;

/** #80: one ANC visit. LMP can't be in the future, and the EDD comes after it. */
export async function addAncRecord(db: Queryable, patientId: string, input: NewAncRecord, by: string, now = new Date()): Promise<AncRecord> {
  if (input.lmp && input.lmp > indiaDate(now)) throw new AppError(422, 'invalid_input', 'lmp: cannot be in the future');
  if (input.lmp && input.edd && input.edd <= input.lmp) throw new AppError(422, 'invalid_input', 'edd: must be after lmp');
  if (input.encounterId) await assertPatientEncounter(db, patientId, input.encounterId);
  const { rows } = await db.query(
    `INSERT INTO anc_records (id, status, created_by, updated_by, patient_id, encounter_id, lmp, edd, gravida, para, gestation_weeks, bp,
       weight_kg, fundal_height_cm, fhr, notes)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *, lmp::text AS lmp_text, edd::text AS edd_text`,
    [
      randomUUID(), by, patientId, input.encounterId ?? null, input.lmp ?? null, input.edd ?? null, input.gravida ?? null,
      input.para ?? null, input.gestationWeeks ?? null, input.bp ?? null, input.weightKg ?? null, input.fundalHeightCm ?? null,
      input.fhr ?? null, input.notes ?? null,
    ],
  );
  return toAncRecord(rows[0] as Record<string, unknown>);
}
