import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { PATIENT_SELECT, toPatient, toSummary, type BaseFields, type PatientSummary } from '../patients/patients.js';

// OPD appointments (api-list.md Appointment): a patient booked with a doctor of a department, for a time slot.
// Stored status: booked, arrived (checked in, #34) or cancelled (#35). A booked appointment from an earlier day
// shows as no_show.

export const APPOINTMENT_STATUSES = ['booked', 'arrived', 'cancelled', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export interface Appointment extends Omit<BaseFields, 'status'> {
  status: AppointmentStatus;
  patientId: string;
  doctorId: string;
  departmentId: string;
  at: string;
  durationMin: number;
  note?: string;
  /** On lists, so the desk sees who is coming. */
  patient?: PatientSummary;
}

const DAY_MS = 86_400_000;

export function toAppointment(r: Record<string, unknown>, now = new Date()): Appointment {
  const at = r.at as Date;
  const noShow = r.status === 'booked' && at < indiaDayStart(indiaDate(now));
  return {
    ...baseFields(r as unknown as BaseRow),
    status: noShow ? 'no_show' : (r.status as AppointmentStatus),
    patientId: String(r.patient_id),
    doctorId: String(r.doctor_id),
    departmentId: String(r.department_id),
    at: at.toISOString(),
    durationMin: Number(r.duration_min),
    ...(r.note != null && { note: String(r.note) }),
  };
}

export interface AppointmentQuery {
  /** India date, YYYY-MM-DD. */
  date: string;
  doctorId?: string;
  departmentId?: string;
  status?: AppointmentStatus;
}

/** #31: one day's appointments in time order, each with the patient's summary. */
export async function listAppointments(db: Queryable, query: AppointmentQuery, now = new Date()): Promise<Appointment[]> {
  const start = indiaDayStart(query.date);
  const params: unknown[] = [start, new Date(start.getTime() + DAY_MS)];
  const where = ['a.at >= $1', 'a.at < $2'];
  if (query.doctorId) where.push(`a.doctor_id = $${params.push(query.doctorId)}`);
  if (query.departmentId) where.push(`a.department_id = $${params.push(query.departmentId)}`);
  if (query.status === 'booked' || query.status === 'no_show') {
    // Both are stored as booked: before today it is a no-show.
    const today = `$${params.push(indiaDayStart(indiaDate(now)))}`;
    where.push(`a.status = 'booked' AND a.at ${query.status === 'booked' ? '>=' : '<'} ${today}`);
  } else if (query.status) {
    where.push(`a.status = $${params.push(query.status)}`);
  }
  const { rows } = await db.query(`SELECT * FROM appointments a WHERE ${where.join(' AND ')} ORDER BY a.at, a.id`, params);
  return withPatients(db, rows, now);
}

/** The appointments of `rows`, each with its patient's summary (one query for all the patients). */
async function withPatients(db: Queryable, rows: Record<string, unknown>[], now: Date): Promise<Appointment[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => String(r.patient_id)))];
  const patients = await db.query(`${PATIENT_SELECT} WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids);
  const byId = new Map(patients.rows.map((p) => [String(p.id), toSummary(toPatient(p, now))]));
  return rows.map((r) => ({ ...toAppointment(r, now), patient: byId.get(String(r.patient_id)) }));
}

const notFound = () => new AppError(404, 'not_found', 'no such appointment');
const invalid = (message: string) => new AppError(422, 'invalid_input', message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getAppointment(db: Queryable, id: string, now = new Date()): Promise<Appointment> {
  if (!UUID.test(id)) throw notFound();
  const { rows } = await db.query('SELECT * FROM appointments WHERE id = $1', [id]);
  const [appointment] = await withPatients(db, rows, now);
  if (!appointment) throw notFound();
  return appointment;
}

export const DEFAULT_DURATION_MIN = 10;

export interface NewAppointment {
  patientId: string;
  doctorId: string;
  departmentId: string;
  /** ISO time. */
  at: string;
  durationMin?: number;
  note?: string;
}

/** 422 unless `doctorId` is an active doctor (or Head Doctor) of `departmentId`. */
export async function checkDoctor(db: Queryable, doctorId: string, departmentId: string): Promise<void> {
  const { rows } = await db.query(
    "SELECT department_ids FROM users WHERE id = $1 AND active AND type IN ('doctor', 'head_doctor')",
    [doctorId],
  );
  if (!rows[0]) throw invalid('doctorId: no such active doctor');
  if (!(JSON.parse(String(rows[0].department_ids)) as string[]).includes(departmentId)) {
    throw invalid('departmentId: the doctor is not in this department');
  }
}

/**
 * 409 slot_taken if the doctor has a booked or arrived appointment overlapping [at, endsAt). `except` leaves out the
 * appointment being moved. Two bookings at the very same moment could both pass; the desk sees both on the list.
 */
export async function checkSlot(db: Queryable, doctorId: string, at: Date, endsAt: Date, except?: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM appointments
     WHERE doctor_id = $1 AND status IN ('booked', 'arrived') AND at < $3 AND ends_at > $2 AND id <> $4 LIMIT 1`,
    [doctorId, at, endsAt, except ?? '00000000-0000-0000-0000-000000000000'],
  );
  if (rows[0]) throw new AppError(409, 'slot_taken', 'the doctor already has an appointment at this time');
}

/** #32 */
export async function bookAppointment(db: Queryable, input: NewAppointment, by: string, now = new Date()): Promise<Appointment> {
  const patient = await db.query('SELECT merged_into FROM patients WHERE id = $1', [input.patientId]);
  if (!patient.rows[0]) throw invalid('patientId: no such patient');
  if (patient.rows[0].merged_into != null) throw invalid('patientId: this patient was merged into another');
  await checkDoctor(db, input.doctorId, input.departmentId);
  const at = new Date(input.at);
  if (at < now) throw invalid('at: this time has passed');
  const durationMin = input.durationMin ?? DEFAULT_DURATION_MIN;
  const endsAt = new Date(at.getTime() + durationMin * 60_000);
  await checkSlot(db, input.doctorId, at, endsAt);

  const id = randomUUID();
  await db.query(
    `INSERT INTO appointments (id, status, created_by, updated_by, patient_id, doctor_id, department_id, at, ends_at, duration_min, note)
     VALUES ($1, 'booked', $2, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, by, input.patientId, input.doctorId, input.departmentId, at, endsAt, durationMin, input.note ?? null],
  );
  return getAppointment(db, id, now);
}

export interface AppointmentChange {
  version: number;
  doctorId?: string;
  at?: string;
  durationMin?: number;
  /** null clears it. */
  note?: string | null;
}

/** 409 unless the appointment is still booked for today or later. */
function assertBooked(appointment: Appointment): void {
  if (appointment.status !== 'booked') throw new AppError(409, 'not_booked', `this appointment is ${appointment.status.replace('_', '-')}`);
}

/** #33: moves the appointment (time, doctor of the same department, length) or changes its note. */
export async function updateAppointment(db: Queryable, id: string, change: AppointmentChange, by: string, now = new Date()): Promise<Appointment> {
  const current = await getAppointment(db, id, now);
  assertBooked(current);
  const doctorId = change.doctorId ?? current.doctorId;
  if (change.doctorId !== undefined) await checkDoctor(db, doctorId, current.departmentId);
  const at = new Date(change.at ?? current.at);
  if (change.at !== undefined && at < now) throw invalid('at: this time has passed');
  const durationMin = change.durationMin ?? current.durationMin;
  const endsAt = new Date(at.getTime() + durationMin * 60_000);
  if (change.doctorId !== undefined || change.at !== undefined || change.durationMin !== undefined) {
    await checkSlot(db, doctorId, at, endsAt, id);
  }

  const set: Record<string, unknown> = { doctor_id: doctorId, at, ends_at: endsAt, duration_min: durationMin };
  if (change.note !== undefined) set.note = change.note;
  await updateRecord(db, 'appointments', { id, version: change.version, by, set });
  return getAppointment(db, id, now);
}
