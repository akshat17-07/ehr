import type { Queryable } from '../../db/migrate.js';

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
