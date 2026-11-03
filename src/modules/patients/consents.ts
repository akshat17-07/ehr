import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
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
  withdrawnReason?: string;
  /** The portal patient who withdrew it: the patient, or a parent for a minor. */
  withdrawnByPatientId?: string;
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
    ...(r.withdrawn_reason != null && { withdrawnReason: String(r.withdrawn_reason) }),
    ...(r.withdrawn_by_patient_id != null && { withdrawnByPatientId: String(r.withdrawn_by_patient_id) }),
    ...(r.document_id != null && { documentId: String(r.document_id) }),
  };
}

// Which consents a patient may withdraw (DPDP s.6(4): as easy as giving it; withdrawal does not undo what was done
// before). Only purpose consents that go on being used: sharing updates with the referring doctor and research.
// A treatment consent covers care already given (to refuse more, the patient tells the doctor), and the privacy
// notice consent records that the notice was shown; care itself is a legitimate use (DPDP s.7), so objecting to
// processing is a rights request (#258, kind withdraw_consent) for the grievance officer, not a click.
export const WITHDRAWABLE_KINDS: readonly ConsentKind[] = ['share_with_referrer', 'research'];

export const isWithdrawable = (c: Consent) => c.given && !c.withdrawnAt && WITHDRAWABLE_KINDS.includes(c.kind);

/**
 * #256: withdraws a given consent; the row stays, marked withdrawn (status 'withdrawn', withdrawn_at, reason, who).
 * 409 already_withdrawn; 422 not_given for a refusal (nothing to withdraw); 422 not_withdrawable for a treatment
 * or privacy notice consent. Downstream: nothing reads share_with_referrer or research consents yet, so a reader
 * added later must check withdrawn_at.
 */
export async function withdrawConsent(
  db: Queryable,
  id: string,
  input: { reason?: string; byPatientId: string; by: string },
  now = new Date(),
): Promise<Consent> {
  const { rows } = await db.query('SELECT * FROM consents WHERE id = $1 AND voided_at IS NULL', [id]);
  if (!rows[0]) throw new AppError(404, 'not_found');
  const consent = toConsent(rows[0] as Record<string, unknown>);
  if (consent.withdrawnAt) throw new AppError(409, 'already_withdrawn', 'this consent is already withdrawn', { withdrawnAt: consent.withdrawnAt });
  if (!consent.given) throw new AppError(422, 'not_given', 'this consent was refused; there is nothing to withdraw');
  if (!WITHDRAWABLE_KINDS.includes(consent.kind)) {
    throw new AppError(
      422,
      'not_withdrawable',
      consent.kind === 'treatment'
        ? 'a treatment consent covers care already given; to refuse further treatment, tell your doctor'
        : 'the privacy notice consent records that the notice was shown; to object to processing, file a rights request',
    );
  }
  const row = await updateRecord(db, 'consents', {
    id,
    version: consent.version,
    by: input.by,
    reason: input.reason ?? 'withdrawn by the patient',
    set: { status: 'withdrawn', withdrawn_at: now, withdrawn_reason: input.reason ?? null, withdrawn_by_patient_id: input.byPatientId },
  });
  return toConsent(row);
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
