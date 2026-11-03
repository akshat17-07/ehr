import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from '../patients/patients.js';

// Salary structures (api-list.md SalaryStructure). Money is whole paise; allowances is stored as JSON text.

export interface SalaryStructure extends BaseFields {
  name: string;
  basicPaise: number;
  hraPaise: number;
  allowances: { name: string; paise: number }[];
  epf: boolean;
  esi: boolean;
  professionalTax: boolean;
  tdsMonthlyPaise: number | null;
}

export function toSalaryStructure(r: Record<string, unknown>): SalaryStructure {
  return {
    ...baseFields(r as unknown as BaseRow),
    name: String(r.name),
    basicPaise: Number(r.basic_paise),
    hraPaise: Number(r.hra_paise),
    allowances: JSON.parse(String(r.allowances)) as { name: string; paise: number }[],
    epf: r.epf === true,
    esi: r.esi === true,
    professionalTax: r.professional_tax === true,
    tdsMonthlyPaise: r.tds_monthly_paise == null ? null : Number(r.tds_monthly_paise),
  };
}

/** #208: all structures that are not voided, by name (a short list, so not paged). */
export async function listSalaryStructures(db: Queryable): Promise<SalaryStructure[]> {
  const { rows } = await db.query('SELECT * FROM salary_structures WHERE voided_at IS NULL ORDER BY name, id');
  return rows.map((r) => toSalaryStructure(r as Record<string, unknown>));
}
