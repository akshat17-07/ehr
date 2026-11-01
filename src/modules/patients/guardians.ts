import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { getPatient, type BaseFields } from './patients.js';

// A patient's guardians (api-list.md Guardian): parents of a child, the family of an elderly or very ill patient.
// guardianPatientId links a guardian who is a patient here too. portalAccess lets them see the patient in the
// patient portal, where they sign in with their mobile number, so it needs one.

export interface Guardian extends BaseFields {
  patientId: string;
  guardianPatientId?: string;
  name: string;
  relation: string;
  mobile?: string;
  portalAccess: boolean;
}

export interface NewGuardian {
  name: string;
  relation: string;
  mobile?: string;
  guardianPatientId?: string;
  portalAccess?: boolean;
}

export function toGuardian(r: Record<string, unknown>): Guardian {
  return {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    ...(r.guardian_patient_id != null && { guardianPatientId: String(r.guardian_patient_id) }),
    name: String(r.name),
    relation: String(r.relation),
    ...(r.mobile != null && { mobile: String(r.mobile) }),
    portalAccess: r.portal_access === true,
  };
}

const invalid = (message: string) => new AppError(422, 'invalid_input', message);

/** #26 */
export async function addGuardian(db: Queryable, patientId: string, input: NewGuardian, by: string): Promise<Guardian> {
  await getPatient(db, patientId);
  if (input.portalAccess && !input.mobile) throw invalid('portal access needs the guardian\'s mobile number');
  if (input.guardianPatientId !== undefined) {
    if (input.guardianPatientId === patientId) throw invalid('a patient can\'t be their own guardian');
    await getPatient(db, input.guardianPatientId).catch(() => {
      throw invalid('guardianPatientId: no such patient');
    });
  }
  const { rows } = await db.query(
    `INSERT INTO guardians (id, status, created_by, updated_by, patient_id, guardian_patient_id, name, relation, mobile, portal_access)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [randomUUID(), by, patientId, input.guardianPatientId ?? null, input.name, input.relation, input.mobile ?? null, input.portalAccess ?? false],
  );
  return toGuardian(rows[0] as Record<string, unknown>);
}
