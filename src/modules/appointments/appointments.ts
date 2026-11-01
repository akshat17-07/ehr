import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
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
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((r) => String(r.patient_id)))];
  const patients = await db.query(`${PATIENT_SELECT} WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids);
  const byId = new Map(patients.rows.map((p) => [String(p.id), toSummary(toPatient(p, now))]));
  return rows.map((r) => ({ ...toAppointment(r, now), patient: byId.get(String(r.patient_id)) }));
}
