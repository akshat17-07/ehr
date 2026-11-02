import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';

// PC-PNDT Form F (api-list.md FormF): filled for every pregnancy scan, one per encounter. The Act forbids telling
// fetal sex, so nothing here can hold it.

export interface FormF extends BaseFields {
  encounterId: string;
  patientId: string;
  indication: string;
  procedure: string;
  doctorId: string;
  declarationSigned: boolean;
  documentId?: string;
}

export function toFormF(r: Record<string, unknown>): FormF {
  return {
    ...baseFields(r as unknown as BaseRow),
    encounterId: String(r.encounter_id),
    patientId: String(r.patient_id),
    indication: String(r.indication),
    procedure: String(r.procedure),
    doctorId: String(r.doctor_id),
    declarationSigned: Boolean(r.declaration_signed),
    ...(r.document_id != null && { documentId: String(r.document_id) }),
  };
}

/** #81: the encounter's Form F; 404 if none is written. */
export async function getFormF(db: Queryable, encounterId: string): Promise<FormF> {
  const { rows } = await db.query('SELECT * FROM form_f WHERE encounter_id = $1', [encounterId]);
  if (!rows[0]) throw new AppError(404, 'not_found', 'no Form F for this encounter');
  return toFormF(rows[0] as Record<string, unknown>);
}
