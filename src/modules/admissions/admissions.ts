import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { createEncounter } from '../encounters/encounters.js';
import { patientSummaries, type BaseFields, type PatientSummary } from '../patients/patients.js';

// IPD admissions (api-list.md Admission): a patient in a ward bed under a doctor. Admitting opens the IPD encounter
// that holds the stay's notes, vitals, orders and prescriptions; the signed discharge summary (#76) ends both.
// Wards and beds are the hospital's own names (free text).

export const ADMISSION_STATUSES = ['current', 'discharged'] as const;
export type AdmissionStatus = (typeof ADMISSION_STATUSES)[number];

export interface Admission extends Omit<BaseFields, 'status'> {
  status: AdmissionStatus;
  patientId: string;
  encounterId: string;
  departmentId: string;
  doctorId: string;
  ward: string;
  bed: string;
  reason?: string;
  admittedAt: string;
  dischargedAt?: string;
  /** In lists (#70). */
  patient?: PatientSummary;
}

export function toAdmission(r: Record<string, unknown>): Admission {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as AdmissionStatus,
    patientId: String(r.patient_id),
    encounterId: String(r.encounter_id),
    departmentId: String(r.department_id),
    doctorId: String(r.doctor_id),
    ward: String(r.ward),
    bed: String(r.bed),
    ...(r.reason != null && { reason: String(r.reason) }),
    admittedAt: (r.admitted_at as Date).toISOString(),
    ...(r.discharged_at != null && { dischargedAt: (r.discharged_at as Date).toISOString() }),
  };
}

/** The unique key of an occupied bed (ward names compared without case). */
export const bedKey = (ward: string, bed: string) => `${ward.toLowerCase()}|${bed.toLowerCase()}`;

/** 409 if the bed has a current admission. */
export async function assertBedFree(db: Queryable, ward: string, bed: string): Promise<void> {
  const taken = await db.query('SELECT 1 FROM admissions WHERE bed_key = $1', [bedKey(ward, bed)]);
  if (taken.rows[0]) throw new AppError(409, 'bed_taken', `${ward} bed ${bed} is taken`);
}

export interface NewAdmission {
  patientId: string;
  departmentId: string;
  doctorId: string;
  ward: string;
  bed: string;
  reason?: string;
}

/** #69: 409 if the patient is already admitted or the bed is taken; opens the IPD encounter with it. */
export async function admit(db: Queryable, input: NewAdmission, by: string, now = new Date()): Promise<Admission> {
  const current = await db.query('SELECT 1 FROM admissions WHERE current_patient = $1', [input.patientId]);
  if (current.rows[0]) throw new AppError(409, 'already_admitted', 'this patient is already admitted');
  await assertBedFree(db, input.ward, input.bed);
  return withTransaction(db, async (tx) => {
    const encounter = await createEncounter(
      tx,
      { patientId: input.patientId, type: 'IPD', departmentId: input.departmentId, doctorId: input.doctorId },
      by,
      now,
    );
    try {
      const { rows } = await tx.query(
        `INSERT INTO admissions (id, status, created_by, updated_by, patient_id, encounter_id, department_id, doctor_id, ward, bed,
           reason, admitted_at, bed_key, current_patient)
         VALUES ($1, 'current', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $3) RETURNING *`,
        [
          randomUUID(), by, input.patientId, encounter.id, input.departmentId, input.doctorId, input.ward, input.bed,
          input.reason ?? null, now, bedKey(input.ward, input.bed),
        ],
      );
      return toAdmission(rows[0] as Record<string, unknown>);
    } catch (error) {
      // 23505: another admission took the bed or admitted the patient in between.
      if ((error as { code?: string }).code === '23505') throw new AppError(409, 'conflict', 'the bed or the patient was just admitted: try again');
      throw error;
    }
  });
}

export interface AdmissionQuery extends PageQuery {
  ward?: string;
  doctorId?: string;
  /** Default true: the patients in beds now, by ward and bed. false: every admission, newest first. */
  current?: boolean;
}

/** #70, each with the patient's summary. */
export async function listAdmissions(db: Queryable, query: AdmissionQuery, now = new Date()): Promise<Page<Admission>> {
  const current = query.current ?? true;
  const params: unknown[] = [];
  const where = current ? ["status = 'current'"] : [];
  if (query.ward) where.push(`lower(ward) = $${params.push(query.ward.toLowerCase())}`);
  if (query.doctorId) where.push(`doctor_id = $${params.push(query.doctorId)}`);
  const order = current ? { orderBy: ['ward', 'bed', 'id'], direction: 'asc' as const } : { orderBy: ['admitted_at', 'id'] };
  const page = await pageRows(db, { select: 'SELECT * FROM admissions', where, params, ...order }, query, toAdmission);
  const byId = await patientSummaries(db, page.items.map((a) => a.patientId), now);
  return { ...page, items: page.items.map((a) => ({ ...a, patient: byId.get(a.patientId) })) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One admission; 404 if there is none. */
export async function getAdmission(db: Queryable, id: string): Promise<Admission> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM admissions WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such admission');
  return toAdmission(rows[0] as Record<string, unknown>);
}

/** #71: moves a current admission to another bed (the old bed is in the history, with the reason). */
export async function transfer(
  db: Queryable,
  id: string,
  input: { version: number; ward: string; bed: string; reason?: string },
  by: string,
): Promise<Admission> {
  const admission = await getAdmission(db, id);
  if (admission.status !== 'current') throw new AppError(409, 'discharged', 'this patient has been discharged');
  const key = bedKey(input.ward, input.bed);
  if (key === bedKey(admission.ward, admission.bed)) throw new AppError(422, 'invalid_input', 'bed: the patient is already in this bed');
  await assertBedFree(db, input.ward, input.bed);
  try {
    const row = await updateRecord(db, 'admissions', {
      id,
      version: input.version,
      by,
      set: { ward: input.ward, bed: input.bed, bed_key: key },
      ...(input.reason && { reason: input.reason }),
    });
    return toAdmission(row);
  } catch (error) {
    // 23505: another admission took the bed in between.
    if ((error as { code?: string }).code === '23505') throw new AppError(409, 'bed_taken', `${input.ward} bed ${input.bed} is taken`);
    throw error;
  }
}
