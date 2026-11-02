import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { assertPatientDocuments } from '../documents/documents.js';
import { getPatient, type BaseFields } from './patients.js';

// Consents (api-list.md Consent; DPDP Act 2023): what the patient agreed to, or refused, and when. The privacy notice
// consent keeps the notice version and the language it was shown in. A patient withdraws a consent later (#256);
// the row stays, with withdrawn_at set.

export const CONSENT_KINDS = ['privacy_notice', 'treatment', 'share_with_referrer', 'research'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];
export const LANGUAGES = ['en', 'hi'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Consent extends BaseFields {
  patientId: string;
  kind: ConsentKind;
  noticeVersion?: string;
  language: Language;
  given: boolean;
  givenAt: string;
  withdrawnAt?: string;
  documentId?: string;
}

export interface NewConsent {
  kind: ConsentKind;
  noticeVersion?: string;
  language: Language;
  given: boolean;
  /** The signed form, uploaded first (#94). */
  documentId?: string;
}

export function toConsent(r: Record<string, unknown>): Consent {
  return {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    kind: r.kind as ConsentKind,
    ...(r.notice_version != null && { noticeVersion: String(r.notice_version) }),
    language: r.language as Language,
    given: r.given === true,
    givenAt: (r.given_at as Date).toISOString(),
    ...(r.withdrawn_at instanceof Date && { withdrawnAt: r.withdrawn_at.toISOString() }),
    ...(r.document_id != null && { documentId: String(r.document_id) }),
  };
}

/** #27: records the patient's answer, given or refused, as of now. */
export async function recordConsent(db: Queryable, patientId: string, input: NewConsent, by: string, now = new Date()): Promise<Consent> {
  await getPatient(db, patientId);
  if (input.documentId) await assertPatientDocuments(db, patientId, [input.documentId], 'documentId');
  if (input.kind === 'privacy_notice' && !input.noticeVersion) {
    throw new AppError(422, 'invalid_input', 'noticeVersion: which privacy notice was shown');
  }
  const { rows } = await db.query(
    `INSERT INTO consents (id, status, created_by, updated_by, patient_id, kind, notice_version, language, given, given_at, document_id)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [randomUUID(), by, patientId, input.kind, input.noticeVersion ?? null, input.language, input.given, now, input.documentId ?? null],
  );
  return toConsent(rows[0] as Record<string, unknown>);
}
