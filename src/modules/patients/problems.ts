import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from './patients.js';

// Problem list (api-list.md Problem): the patient's ongoing conditions (diabetes, hypertension), across encounters.
// status: active until resolved (#57).

export const PROBLEM_STATUSES = ['active', 'resolved'] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export interface Problem extends Omit<BaseFields, 'status'> {
  status: ProblemStatus;
  patientId: string;
  icd10?: string;
  text: string;
  /** Dates, YYYY-MM-DD. */
  onset?: string;
  resolvedAt?: string;
}

export const PROBLEM_SELECT = 'SELECT problems.*, onset::text AS onset_text, resolved_at::text AS resolved_at_text FROM problems';

export function toProblem(r: Record<string, unknown>): Problem {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as ProblemStatus,
    patientId: String(r.patient_id),
    ...(r.icd10 != null && { icd10: String(r.icd10) }),
    text: String(r.text),
    ...(r.onset_text != null && { onset: String(r.onset_text) }),
    ...(r.resolved_at_text != null && { resolvedAt: String(r.resolved_at_text) }),
  };
}

/** #55: active problems first, then resolved; `active` keeps one kind only. */
export async function listProblems(db: Queryable, patientId: string, active?: boolean): Promise<Problem[]> {
  const filter = active === undefined ? '' : ` AND status = '${active ? 'active' : 'resolved'}'`;
  const { rows } = await db.query(
    `${PROBLEM_SELECT} WHERE patient_id = $1 AND voided_at IS NULL${filter} ORDER BY status, created_at, id`,
    [patientId],
  );
  return rows.map(toProblem);
}
