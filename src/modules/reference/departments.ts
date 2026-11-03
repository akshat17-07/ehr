import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';

// Hospital departments (api-list.md Department). Few rows, so lists are not paged.

export interface Department {
  id: string;
  version: number;
  code: string;
  nameEn: string;
  nameHi: string;
  active: boolean;
}

const toDepartment = (r: Record<string, unknown>): Department => ({
  id: String(r.id),
  version: Number(r.version),
  code: String(r.code),
  nameEn: String(r.name_en),
  nameHi: String(r.name_hi),
  active: r.active === true,
});

/** #9: departments A to Z by English name. */
export async function listDepartments(db: Queryable, filter: { active?: boolean } = {}): Promise<Department[]> {
  const { rows } =
    filter.active === undefined
      ? await db.query('SELECT * FROM departments ORDER BY name_en, id')
      : await db.query('SELECT * FROM departments WHERE active = $1 ORDER BY name_en, id', [filter.active]);
  return rows.map(toDepartment);
}

export interface NewDepartment {
  /** Upper case letters and digits, e.g. MED. */
  code: string;
  nameEn: string;
  nameHi: string;
}

/** #190: adds a department. 409 duplicate if the code is taken (codes are never reused; deactivate instead). */
export async function addDepartment(db: Queryable, input: NewDepartment, by: string): Promise<Department> {
  const { rows: taken } = await db.query('SELECT id FROM departments WHERE code = $1', [input.code]);
  if (taken[0]) throw new AppError(409, 'duplicate', 'a department with this code exists', { departmentId: String(taken[0].id) });
  try {
    const { rows } = await db.query(
      `INSERT INTO departments (id, status, created_by, updated_by, code, name_en, name_hi, active)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, true) RETURNING *`,
      [randomUUID(), by, input.code, input.nameEn, input.nameHi],
    );
    return toDepartment(rows[0] as Record<string, unknown>);
  } catch (error) {
    // 23505: another request took the code between the check and the insert.
    if ((error as { code?: string }).code === '23505') throw new AppError(409, 'duplicate', 'a department with this code exists');
    throw error;
  }
}
