import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';

// #701: the doctor picker. Only what a picker needs; no phone, email or other personal data.

export interface DoctorOption {
  /** users.id: the id every doctorId field (appointments, visits, surgeries) holds. */
  id: string;
  name: string;
  /** The filtered department, else the first of the doctor's departments; null if none. */
  departmentId: string | null;
  registrationNo: string | null;
}

/** Active doctors and head doctors by name; q matches anywhere in the name, departmentId keeps one department. */
export async function listDoctors(db: Queryable, query: PageQuery & { q?: string; departmentId?: string }): Promise<Page<DoctorOption>> {
  const params: unknown[] = [];
  const where = ['active', "type IN ('doctor', 'head_doctor')"];
  if (query.departmentId) where.push(`department_ids LIKE $${params.push(`%"${query.departmentId}"%`)}`);
  if (query.q) where.push(`lower(name) LIKE $${params.push(`%${query.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`)}`);
  return pageRows(
    db,
    { select: 'SELECT id, name, department_ids, council_reg_no FROM users', where, params, orderBy: ['name', 'id'], direction: 'asc' },
    query,
    (r) => ({
      id: String(r.id),
      name: String(r.name),
      departmentId: query.departmentId ?? (JSON.parse(String(r.department_ids)) as string[])[0] ?? null,
      registrationNo: r.council_reg_no == null ? null : String(r.council_reg_no),
    }),
  );
}
