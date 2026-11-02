import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import { assertPatientDocuments } from '../documents/documents.js';
import { getPatient, patientSummaries, type BaseFields, type PatientSummary } from '../patients/patients.js';

// MTP register (api-list.md MtpEntry): the hospital's register of medical terminations of pregnancy, as the
// MTP Act wants it kept. Access is by grant only (mtp.view / mtp.write).

export interface MtpEntry extends BaseFields {
  patientId: string;
  /** Dates, YYYY-MM-DD. */
  admissionDate: string;
  gestationWeeks: number;
  indication: string;
  /** The doctors whose opinion the termination rests on. */
  opinionDoctorIds: string[];
  procedureDate?: string;
  documentId?: string;
  /** On lists. */
  patient?: PatientSummary;
}

export const MTP_SELECT =
  'SELECT mtp_register.*, admission_date::text AS admission_text, procedure_date::text AS procedure_text FROM mtp_register';

export function toMtpEntry(r: Record<string, unknown>): MtpEntry {
  return {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    admissionDate: String(r.admission_text),
    gestationWeeks: Number(r.gestation_weeks),
    indication: String(r.indication),
    opinionDoctorIds: JSON.parse(String(r.opinion_doctor_ids)) as string[],
    ...(r.procedure_text != null && { procedureDate: String(r.procedure_text) }),
    ...(r.document_id != null && { documentId: String(r.document_id) }),
  };
}

export interface MtpQuery extends PageQuery {
  /** Admission dates, YYYY-MM-DD, both inclusive. */
  from?: string;
  to?: string;
}

/** #83: newest admission first, each with the patient's summary. */
export async function listMtp(db: Queryable, query: MtpQuery, now = new Date()): Promise<Page<MtpEntry>> {
  const params: unknown[] = [];
  const where = ['voided_at IS NULL'];
  if (query.from) where.push(`admission_date >= $${params.push(query.from)}`);
  if (query.to) where.push(`admission_date <= $${params.push(query.to)}`);
  const page = await pageRows(db, { select: MTP_SELECT, where, params, orderBy: ['admission_date', 'id'] }, query, toMtpEntry);
  const byId = await patientSummaries(db, page.items.map((e) => e.patientId), now);
  return { ...page, items: page.items.map((e) => ({ ...e, patient: byId.get(e.patientId) })) };
}

export interface NewMtpEntry {
  patientId: string;
  admissionDate: string;
  gestationWeeks: number;
  indication: string;
  opinionDoctorIds: string[];
  procedureDate?: string;
  documentId?: string;
}

/** MTP Act: one doctor's opinion up to 20 weeks, two after that. */
const ONE_OPINION_UP_TO_WEEKS = 20;

function invalid(message: string): never {
  throw new AppError(422, 'invalid_input', message);
}

/** #84: adds the entry and puts the `mtp` label on the patient (once), together. */
export async function addMtpEntry(db: Queryable, input: NewMtpEntry, by: string, now = new Date()): Promise<MtpEntry> {
  const today = indiaDate(now);
  if (input.admissionDate > today) invalid('admissionDate: cannot be in the future');
  if (input.procedureDate && (input.procedureDate > today || input.procedureDate < input.admissionDate)) {
    invalid('procedureDate: between the admission date and today');
  }
  const doctors = [...new Set(input.opinionDoctorIds)];
  if (input.gestationWeeks > ONE_OPINION_UP_TO_WEEKS && doctors.length < 2) {
    invalid(`opinionDoctorIds: two doctors' opinions are needed after ${ONE_OPINION_UP_TO_WEEKS} weeks`);
  }
  const { rows: found } = await db.query(
    `SELECT id FROM users WHERE id IN (${doctors.map((_, i) => `$${i + 1}`).join(', ')}) AND active AND type IN ('doctor', 'head_doctor')`,
    doctors,
  );
  if (found.length !== doctors.length) invalid('opinionDoctorIds: each must be an active doctor');
  const patient = await getPatient(db, input.patientId, now);
  if (patient.sex !== 'F') invalid('patientId: the MTP register is for a female patient');
  if (input.documentId) await assertPatientDocuments(db, patient.id, [input.documentId], 'documentId');

  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO mtp_register (id, status, created_by, updated_by, patient_id, admission_date, gestation_weeks, indication, opinion_doctor_ids, procedure_date,
         document_id)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *, admission_date::text AS admission_text, procedure_date::text AS procedure_text`,
      [randomUUID(), by, patient.id, input.admissionDate, input.gestationWeeks, input.indication, JSON.stringify(doctors), input.procedureDate ?? null,
        input.documentId ?? null],
    );
    if (!patient.labels.includes('mtp')) {
      await updateRecord(tx, 'patients', {
        id: patient.id,
        version: patient.version,
        by,
        set: { labels: JSON.stringify([...patient.labels, 'mtp']) },
        reason: 'MTP register entry',
      });
    }
    return toMtpEntry(rows[0] as Record<string, unknown>);
  });
}
