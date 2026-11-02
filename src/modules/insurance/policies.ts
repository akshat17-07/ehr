import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { indiaDate } from '../../time/india.js';
import { AppError } from '../../middleware/errors.js';
import { assertPatientDocuments } from '../documents/documents.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { UUID } from '../users/users.js';

// Insurance policies on file (api-list.md Policy). Typed in by the TPA desk; there is no insurer portal link.

export interface Policy extends BaseFields {
  patientId: string;
  insurerId: string;
  tpaId?: string;
  policyNo: string;
  memberId?: string;
  holderName: string;
  /** YYYY-MM-DD. */
  validFrom: string;
  /** YYYY-MM-DD, the last day of cover. */
  validTo: string;
  sumInsuredPaise?: number;
  documentIds: string[];
}

/** Columns with the dates as text, so no time zone can move them a day. */
export const POLICY_COLUMNS = 'policies.*, valid_from::text AS valid_from_text, valid_to::text AS valid_to_text';

export function toPolicy(r: Record<string, unknown>): Policy {
  return {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    insurerId: String(r.insurer_id),
    ...(r.tpa_id != null && { tpaId: String(r.tpa_id) }),
    policyNo: String(r.policy_no),
    ...(r.member_id != null && { memberId: String(r.member_id) }),
    holderName: String(r.holder_name),
    validFrom: String(r.valid_from_text ?? r.valid_from),
    validTo: String(r.valid_to_text ?? r.valid_to),
    ...(r.sum_insured_paise != null && { sumInsuredPaise: Number(r.sum_insured_paise) }),
    documentIds: JSON.parse(String(r.document_ids)) as string[],
  };
}

/**
 * #131: the patient's policies, latest cover first; voided ones are left out. active=true: in force today;
 * active=false: not in force (expired or not started). 404 for no patient.
 */
export async function patientPolicies(db: Queryable, patientId: string, query: { active?: 'true' | 'false' }, now = new Date()): Promise<Policy[]> {
  const patient = await getPatient(db, patientId);
  const today = indiaDate(now);
  const inForce = 'valid_from <= $2 AND valid_to >= $2';
  const filter = query.active === 'true' ? ` AND ${inForce}` : query.active === 'false' ? ` AND NOT (${inForce})` : '';
  const { rows } = await db.query(
    `SELECT ${POLICY_COLUMNS} FROM policies WHERE patient_id = $1 AND voided_at IS NULL${filter} ORDER BY valid_to DESC, created_at DESC, id DESC`,
    query.active ? [patient.id, today] : [patient.id],
  );
  return rows.map(toPolicy);
}

export interface PolicyFields {
  insurerId: string;
  tpaId?: string;
  policyNo: string;
  memberId?: string;
  holderName: string;
  validFrom: string;
  validTo: string;
  sumInsuredPaise?: number;
  documentIds?: string[];
}

/** 422 unless the insurer (and TPA) are on the list and active, and the dates run forwards. */
export async function assertPolicyFields(db: Queryable, f: Pick<PolicyFields, 'insurerId' | 'tpaId' | 'validFrom' | 'validTo'>): Promise<void> {
  const active = async (table: 'insurers' | 'tpas', id: string) => (await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND active`, [id])).rows.length > 0;
  if (!(await active('insurers', f.insurerId))) throw new AppError(422, 'validation_failed', 'insurerId: no such active insurer');
  if (f.tpaId && !(await active('tpas', f.tpaId))) throw new AppError(422, 'validation_failed', 'tpaId: no such active TPA');
  if (f.validTo < f.validFrom) throw new AppError(422, 'validation_failed', 'validTo: before validFrom');
}

/** #132: 404 for no patient; 422 for a bad insurer, TPA, dates or documents; 409 duplicate for the same insurer and policy number. */
export async function addPolicy(db: Queryable, patientId: string, input: PolicyFields, by: string): Promise<Policy> {
  const patient = await getPatient(db, patientId);
  await assertPolicyFields(db, input);
  const documentIds = [...new Set(input.documentIds ?? [])];
  await assertPatientDocuments(db, patient.id, documentIds, 'documentIds');
  const { rows: same } = await db.query('SELECT id FROM policies WHERE insurer_id = $1 AND policy_no = $2 AND patient_id = $3 AND voided_at IS NULL', [
    input.insurerId,
    input.policyNo,
    patient.id,
  ]);
  if (same[0]) throw new AppError(409, 'duplicate', 'this policy is already on file', { policyId: String(same[0].id) });
  const { rows } = await db.query(
    `INSERT INTO policies (id, status, created_by, updated_by, patient_id, insurer_id, tpa_id, policy_no, member_id, holder_name, valid_from, valid_to, sum_insured_paise, document_ids)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      randomUUID(), by, patient.id, input.insurerId, input.tpaId ?? null, input.policyNo, input.memberId ?? null, input.holderName,
      input.validFrom, input.validTo, input.sumInsuredPaise ?? null, JSON.stringify(documentIds),
    ],
  );
  return getPolicy(db, String(rows[0]?.id));
}

/** 404 for no policy (or not a UUID). */
export async function getPolicy(db: Queryable, id: string): Promise<Policy> {
  const { rows } = UUID.test(id) ? await db.query(`SELECT ${POLICY_COLUMNS} FROM policies WHERE id = $1`, [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such policy');
  return toPolicy(rows[0] as Record<string, unknown>);
}

export type PolicyChange = { version: number; reason?: string } & Partial<
  Omit<PolicyFields, 'tpaId' | 'memberId' | 'sumInsuredPaise'> & { tpaId: string | null; memberId: string | null; sumInsuredPaise: number | null }
>;

const COLUMNS: Record<string, string> = {
  insurerId: 'insurer_id',
  tpaId: 'tpa_id',
  policyNo: 'policy_no',
  memberId: 'member_id',
  holderName: 'holder_name',
  validFrom: 'valid_from',
  validTo: 'valid_to',
  sumInsuredPaise: 'sum_insured_paise',
};

/**
 * #133: changes the fields given (null clears tpaId, memberId or sumInsuredPaise); the old version is kept.
 * 404 for no policy; 409 voided; 409 for a stale version; 422 / 409 duplicate as at #132.
 */
export async function updatePolicy(db: Queryable, id: string, change: PolicyChange, by: string): Promise<Policy> {
  const current = await getPolicy(db, id);
  if (current.status === 'void') throw new AppError(409, 'voided', 'this record is voided');
  const merged = {
    insurerId: change.insurerId ?? current.insurerId,
    tpaId: change.tpaId === null ? undefined : (change.tpaId ?? current.tpaId),
    validFrom: change.validFrom ?? current.validFrom,
    validTo: change.validTo ?? current.validTo,
  };
  await assertPolicyFields(db, merged);
  const policyNo = change.policyNo ?? current.policyNo;
  if (change.insurerId !== undefined || change.policyNo !== undefined) {
    const { rows: same } = await db.query(
      'SELECT id FROM policies WHERE insurer_id = $1 AND policy_no = $2 AND patient_id = $3 AND voided_at IS NULL AND id <> $4',
      [merged.insurerId, policyNo, current.patientId, id],
    );
    if (same[0]) throw new AppError(409, 'duplicate', 'this policy is already on file', { policyId: String(same[0].id) });
  }
  const set: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = (change as Record<string, unknown>)[field];
    if (value !== undefined) set[column] = value;
  }
  if (change.documentIds !== undefined) {
    const documentIds = [...new Set(change.documentIds)];
    await assertPatientDocuments(db, current.patientId, documentIds, 'documentIds');
    set.document_ids = JSON.stringify(documentIds);
  }
  await updateRecord(db, 'policies', { id, version: change.version, by, set, ...(change.reason && { reason: change.reason }) });
  return getPolicy(db, id);
}
