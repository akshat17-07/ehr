import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';

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
