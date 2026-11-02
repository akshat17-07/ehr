import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { indiaDate } from '../../time/india.js';
import { getPatient, type BaseFields } from '../patients/patients.js';

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
