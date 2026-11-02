import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';

// #149: OPD visits per India day, department and doctor. A visit is new if the patient had no earlier visit of any
// type at this hospital; otherwise it is a follow-up. Voided visits are left out.

export interface OpdRow {
  date: string;
  departmentId: string;
  doctorId: string;
  newPatients: number;
  followUps: number;
  total: number;
}

export interface OpdQuery {
  from: string;
  to: string;
  departmentId?: string;
  doctorId?: string;
}

/** The longest range one report may cover. */
export const OPD_MAX_DAYS = 366;

/** `departments`: only these (a doctor sees their own departments); undefined: all. */
export async function opdReport(db: Queryable, query: OpdQuery, departments?: string[]): Promise<{ rows: OpdRow[] }> {
  const start = indiaDayStart(query.from);
  const end = new Date(indiaDayStart(query.to).getTime() + 86_400_000);
  if ((end.getTime() - start.getTime()) / 86_400_000 > OPD_MAX_DAYS) throw new AppError(422, 'validation_failed', `to: at most ${OPD_MAX_DAYS} days after from`);
  if (departments && query.departmentId && !departments.includes(query.departmentId)) {
    throw new AppError(403, 'forbidden', 'report.clinical: not your department', { permission: 'report.clinical' });
  }
  if (departments?.length === 0) return { rows: [] };
  const where = ["e.type = 'OPD'", 'e.voided_at IS NULL', 'e.started_at >= $1', 'e.started_at < $2'];
  const params: unknown[] = [start, end];
  if (query.departmentId) where.push(`e.department_id = $${params.push(query.departmentId)}`);
  else if (departments) where.push(`e.department_id IN (${departments.map((d) => `$${params.push(d)}`).join(', ')})`);
  if (query.doctorId) where.push(`e.doctor_id = $${params.push(query.doctorId)}`);
  const { rows } = await db.query(
    `SELECT e.started_at, e.department_id, e.doctor_id,
       EXISTS (SELECT 1 FROM encounters p WHERE p.patient_id = e.patient_id AND p.voided_at IS NULL AND (p.started_at < e.started_at OR (p.started_at = e.started_at AND p.id < e.id))) AS seen_before
     FROM encounters e WHERE ${where.join(' AND ')}`,
    params,
  );
  const byKey = new Map<string, OpdRow>();
  for (const r of rows) {
    const date = indiaDate(r.started_at as Date);
    const key = `${date}|${String(r.department_id)}|${String(r.doctor_id)}`;
    const row = byKey.get(key) ?? { date, departmentId: String(r.department_id), doctorId: String(r.doctor_id), newPatients: 0, followUps: 0, total: 0 };
    if (r.seen_before === true) row.followUps += 1;
    else row.newPatients += 1;
    row.total += 1;
    byKey.set(key, row);
  }
  const sorted = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.departmentId.localeCompare(b.departmentId) || a.doctorId.localeCompare(b.doctorId));
  return { rows: sorted };
}

/** The departments a doctor may report on; undefined for everyone else (all departments). */
export async function reportDepartments(db: Queryable, sub: string, type: string | undefined): Promise<string[] | undefined> {
  if (type !== 'doctor') return undefined;
  const { rows } = await db.query('SELECT department_ids FROM users WHERE cognito_sub = $1', [sub]);
  return rows[0] ? (JSON.parse(String(rows[0].department_ids)) as string[]) : [];
}
