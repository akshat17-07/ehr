import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import { getPatient, type BaseFields } from './patients.js';

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

export interface NewProblem {
  text: string;
  icd10?: string;
  onset?: string;
}

/** #56: 422 for a code not in the ICD-10 list or an onset after today; 409 if already an active problem. */
export async function addProblem(db: Queryable, patientId: string, input: NewProblem, by: string, now = new Date()): Promise<Problem> {
  const patient = await getPatient(db, patientId);
  const icd10 = input.icd10?.toUpperCase();
  if (icd10) {
    const code = await db.query("SELECT 1 FROM codes WHERE system = 'icd10' AND code = $1 AND status = 'active'", [icd10]);
    if (!code.rows[0]) throw new AppError(422, 'invalid_input', 'icd10: not in the code list');
  }
  if (input.onset && input.onset > indiaDate(now)) throw new AppError(422, 'invalid_input', 'onset: cannot be in the future');
  const active = await listProblems(db, patient.id, true);
  if (active.some((p) => (icd10 && p.icd10 === icd10) || p.text.toLowerCase() === input.text.toLowerCase())) {
    throw new AppError(409, 'already_recorded', 'this problem is already on the list');
  }
  const id = randomUUID();
  await db.query(
    `INSERT INTO problems (id, status, created_by, updated_by, patient_id, icd10, text, onset)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6)`,
    [id, by, patient.id, icd10 ?? null, input.text, input.onset ?? null],
  );
  const { rows } = await db.query(`${PROBLEM_SELECT} WHERE id = $1`, [id]);
  return toProblem(rows[0] as Record<string, unknown>);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** #57: resolves an active problem (default today); the note is kept as the history reason. */
export async function resolveProblem(
  db: Queryable,
  id: string,
  input: { resolvedAt?: string; note?: string },
  by: string,
  now = new Date(),
): Promise<Problem> {
  const { rows } = UUID.test(id) ? await db.query(`${PROBLEM_SELECT} WHERE id = $1`, [id]) : { rows: [] };
  const problem = rows[0] ? toProblem(rows[0] as Record<string, unknown>) : undefined;
  if (!problem || problem.voidedAt) throw new AppError(404, 'not_found', 'no such problem');
  if (problem.status === 'resolved') throw new AppError(409, 'resolved', 'this problem is already resolved');
  const resolvedAt = input.resolvedAt ?? indiaDate(now);
  if (resolvedAt > indiaDate(now)) throw new AppError(422, 'invalid_input', 'resolvedAt: cannot be in the future');
  if (problem.onset && resolvedAt < problem.onset) throw new AppError(422, 'invalid_input', 'resolvedAt: before the onset');
  await updateRecord(db, 'problems', {
    id,
    version: problem.version,
    by,
    set: { status: 'resolved', resolved_at: resolvedAt },
    ...(input.note && { reason: input.note }),
  });
  const updated = await db.query(`${PROBLEM_SELECT} WHERE id = $1`, [id]);
  return toProblem(updated.rows[0] as Record<string, unknown>);
}
