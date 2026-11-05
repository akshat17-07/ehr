import { randomUUID } from 'node:crypto';
import { SUMMARY_SELECT, toDischargeSummary, type DischargeSummary } from '../admissions/discharge.js';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { patientSummaries, type BaseFields, type PatientSummary } from '../patients/patients.js';
import { encounterPrescriptions, type Prescription } from '../prescriptions/prescriptions.js';
import { checkDoctor } from '../users/users.js';
import { encounterDiagnoses, type Diagnosis } from './diagnoses.js';
import { draftNoteCount, encounterNotes, type Note } from './notes.js';
import { encounterVitals, type Vital } from './vitals.js';

// Encounters (api-list.md Encounter): one visit, OPD, IPD or ER, with a doctor of a department. status: open until
// closed (#40). Opening one is activity, so the patient's last_activity_at moves to now.

export const ENCOUNTER_TYPES = ['OPD', 'IPD', 'ER'] as const;
export type EncounterType = (typeof ENCOUNTER_TYPES)[number];
export const ENCOUNTER_STATUSES = ['open', 'closed'] as const;
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];

export interface Encounter extends Omit<BaseFields, 'status'> {
  status: EncounterStatus;
  patientId: string;
  type: EncounterType;
  departmentId: string;
  doctorId: string;
  appointmentId?: string;
  startedAt: string;
  closedAt?: string;
  /** On lists, so the doctor sees who is waiting. */
  patient?: PatientSummary;
}

export function toEncounter(r: Record<string, unknown>): Encounter {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as EncounterStatus,
    patientId: String(r.patient_id),
    type: r.type as EncounterType,
    departmentId: String(r.department_id),
    doctorId: String(r.doctor_id),
    ...(r.appointment_id != null && { appointmentId: String(r.appointment_id) }),
    startedAt: (r.started_at as Date).toISOString(),
    ...(r.closed_at instanceof Date && { closedAt: r.closed_at.toISOString() }),
  };
}

export interface NewEncounter {
  patientId: string;
  type: EncounterType;
  departmentId: string;
  doctorId: string;
  appointmentId?: string;
}

/** Opens an encounter (the caller has checked the patient, doctor and department). 409 if the appointment has one. */
export async function openEncounter(db: Queryable, input: NewEncounter, by: string, now = new Date()): Promise<Encounter> {
  return withTransaction(db, async (tx) => {
    let rows: Record<string, unknown>[];
    try {
      ({ rows } = await tx.query(
        `INSERT INTO encounters (id, status, created_by, updated_by, patient_id, type, department_id, doctor_id, appointment_id, started_at)
         VALUES ($1, 'open', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [randomUUID(), by, input.patientId, input.type, input.departmentId, input.doctorId, input.appointmentId ?? null, now],
      ));
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new AppError(409, 'already_open', 'this appointment already has an encounter');
      throw error;
    }
    // Kept by the system, not an edit of the patient's details: no new version, so a form open elsewhere still saves.
    await tx.query('UPDATE patients SET last_activity_at = $2 WHERE id = $1 AND (last_activity_at IS NULL OR last_activity_at < $2)', [
      input.patientId,
      now,
    ]);
    return toEncounter(rows[0] as Record<string, unknown>);
  });
}

export interface EncounterQuery extends PageQuery {
  /** India date the encounter started, YYYY-MM-DD; today if not given (all dates when patientId is given). */
  date?: string;
  /** #707: one patient's visits; the caller has checked patient access. */
  patientId?: string;
  doctorId?: string;
  departmentId?: string;
  type?: EncounterType;
  status?: EncounterStatus;
}

const DAY_MS = 86_400_000;

/** #36: one day's encounters in the order they started (the waiting order), each with the patient's summary. */
export async function listEncounters(db: Queryable, query: EncounterQuery, now = new Date()): Promise<Page<Encounter>> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.date || !query.patientId) {
    const start = indiaDayStart(query.date ?? indiaDate(now));
    where.push(`started_at >= $${params.push(start)}`, `started_at < $${params.push(new Date(start.getTime() + DAY_MS))}`);
  }
  if (query.patientId) where.push(`patient_id = $${params.push(query.patientId)}`);
  if (query.doctorId) where.push(`doctor_id = $${params.push(query.doctorId)}`);
  if (query.departmentId) where.push(`department_id = $${params.push(query.departmentId)}`);
  if (query.type) where.push(`type = $${params.push(query.type)}`);
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  const page = await pageRows(
    db,
    { select: 'SELECT * FROM encounters', where, params, orderBy: ['started_at', 'id'], direction: 'asc' },
    query,
    toEncounter,
  );
  const byId = await patientSummaries(db, page.items.map((e) => e.patientId), now);
  return { ...page, items: page.items.map((e) => ({ ...e, patient: byId.get(e.patientId) })) };
}

/** #37 without an appointment (walk-in, emergency, admission): checks the patient and the doctor, then opens it. */
export async function createEncounter(db: Queryable, input: Omit<NewEncounter, 'appointmentId'>, by: string, now = new Date()): Promise<Encounter> {
  const invalid = (message: string) => new AppError(422, 'invalid_input', message);
  const patient = await db.query('SELECT merged_into FROM patients WHERE id = $1', [input.patientId]);
  if (!patient.rows[0]) throw invalid('patientId: no such patient');
  if (patient.rows[0].merged_into != null) throw invalid('patientId: this patient was merged into another');
  await checkDoctor(db, input.doctorId, input.departmentId);
  return openEncounter(db, input, by, now);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getEncounter(db: Queryable, id: string): Promise<Encounter> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM encounters WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such encounter');
  return toEncounter(rows[0] as Record<string, unknown>);
}

/** #38: the encounter with its patient and everything recorded in it. */
export interface EncounterDetail extends Encounter {
  patient: PatientSummary;
  vitals: Vital[];
  notes: Note[];
  diagnoses: Diagnosis[];
  prescriptions: Prescription[];
  /** The stay's discharge summary (draft or signed); null when none. */
  dischargeSummary: DischargeSummary | null;
}

async function encounterSummary(db: Queryable, encounterId: string): Promise<DischargeSummary | null> {
  const { rows } = await db.query(`${SUMMARY_SELECT} WHERE encounter_id = $1`, [encounterId]);
  return rows[0] ? toDischargeSummary(rows[0] as Record<string, unknown>) : null;
}

export async function encounterDetail(db: Queryable, encounter: Encounter, now = new Date()): Promise<EncounterDetail> {
  const patients = await patientSummaries(db, [encounter.patientId], now);
  return {
    ...encounter,
    patient: patients.get(encounter.patientId) as PatientSummary,
    vitals: await encounterVitals(db, encounter.id),
    notes: await encounterNotes(db, encounter.id),
    diagnoses: await encounterDiagnoses(db, encounter.id),
    prescriptions: await encounterPrescriptions(db, encounter.id),
    dischargeSummary: await encounterSummary(db, encounter.id),
  };
}

/** 409 once the encounter is closed: it can then only be added to (addenda), not changed. */
export function assertOpen(encounter: Encounter): void {
  if (encounter.status !== 'open') throw new AppError(409, 'closed', 'this encounter is closed');
}

export interface EncounterChange {
  version: number;
  departmentId?: string;
  doctorId?: string;
  type?: EncounterType;
  reason?: string;
}

/** #39: moves an open encounter to another doctor or department, or changes its type (an OPD visit admitted as IPD). */
export async function updateEncounter(db: Queryable, id: string, change: EncounterChange, by: string): Promise<Encounter> {
  const current = await getEncounter(db, id);
  assertOpen(current);
  const doctorId = change.doctorId ?? current.doctorId;
  const departmentId = change.departmentId ?? current.departmentId;
  if (change.doctorId !== undefined || change.departmentId !== undefined) await checkDoctor(db, doctorId, departmentId);
  await updateRecord(db, 'encounters', {
    id,
    version: change.version,
    by,
    reason: change.reason,
    set: { doctor_id: doctorId, department_id: departmentId, type: change.type ?? current.type },
  });
  return getEncounter(db, id);
}

/** #40: closes an open encounter. 409 while a note is still a draft: it must be signed (or voided) first. */
export async function closeEncounter(db: Queryable, id: string, by: string, now = new Date()): Promise<Encounter> {
  const current = await getEncounter(db, id);
  assertOpen(current);
  if ((await draftNoteCount(db, id)) > 0) throw new AppError(409, 'draft_notes', 'sign the draft notes before closing');
  await updateRecord(db, 'encounters', { id, version: current.version, by, set: { status: 'closed', closed_at: now } });
  return getEncounter(db, id);
}
