import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { assertPatientDocuments } from '../documents/documents.js';
import { assertOpen, type Encounter } from '../encounters/encounters.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { prescriberId } from '../prescriptions/prescriptions.js';

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

/** Any body key that looks like fetal sex or gender. */
const FETAL_SEX = /sex|gender/i;

/** #82: 422 fetal_sex_forbidden if the body carries such a field, whatever its value. */
export function assertNoFetalSex(body: unknown): void {
  if (body && typeof body === 'object' && Object.keys(body).some((k) => FETAL_SEX.test(k))) {
    throw new AppError(422, 'fetal_sex_forbidden', 'PC-PNDT Act: fetal sex is never recorded');
  }
}

/** #82: written by the doctor doing the scan, in an open encounter of a female patient; one per encounter. */
export async function writeFormF(
  db: Queryable,
  encounter: Encounter,
  input: { indication: string; procedure: string; documentId?: string },
  by: string,
): Promise<FormF> {
  assertOpen(encounter);
  const patient = await getPatient(db, encounter.patientId);
  if (patient.sex !== 'F') throw new AppError(422, 'invalid_input', 'Form F is for a female patient');
  if (input.documentId) await assertPatientDocuments(db, patient.id, [input.documentId], 'documentId');
  const { rows: existing } = await db.query('SELECT id FROM form_f WHERE encounter_id = $1', [encounter.id]);
  if (existing[0]) throw new AppError(409, 'already_written', 'this encounter already has a Form F');
  try {
    const { rows } = await db.query(
      `INSERT INTO form_f (id, status, created_by, updated_by, encounter_id, patient_id, doctor_id, indication, procedure, declaration_signed, document_id)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, true, $8) RETURNING *`,
      [randomUUID(), by, encounter.id, encounter.patientId, await prescriberId(db, by), input.indication, input.procedure, input.documentId ?? null],
    );
    return toFormF(rows[0] as Record<string, unknown>);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, 'already_written', 'this encounter already has a Form F');
    throw err;
  }
}
