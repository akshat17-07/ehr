import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { patientSummaries, type BaseFields, type PatientSummary } from '../patients/patients.js';

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
