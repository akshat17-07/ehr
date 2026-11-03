import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
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

const paise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const name = z.string().trim().min(1).max(100);

export const newSalaryStructureBody = z
  .object({
    name,
    basicPaise: paise,
    hraPaise: paise,
    allowances: z.array(z.object({ name, paise }).strict()).max(20).default([]),
    epf: z.boolean(),
    esi: z.boolean(),
    professionalTax: z.boolean(),
    tdsMonthlyPaise: paise.optional(),
  })
  .strict()
  .refine((b) => new Set(b.allowances.map((a) => a.name.toLowerCase())).size === b.allowances.length, {
    message: 'allowance names must be unique',
    path: ['allowances'],
  });
export type NewSalaryStructure = z.infer<typeof newSalaryStructureBody>;

/** #321: adds a salary structure. Names are unique, ignoring case. */
export async function addSalaryStructure(db: Queryable, input: NewSalaryStructure, by: string): Promise<SalaryStructure> {
  const dup = await db.query('SELECT 1 FROM salary_structures WHERE lower(name) = lower($1)', [input.name]);
  if (dup.rows.length > 0) throw new AppError(409, 'duplicate', 'a salary structure with this name exists');
  try {
    const { rows } = await db.query(
      `INSERT INTO salary_structures (id, status, created_by, updated_by, name, basic_paise, hra_paise, allowances, epf, esi, professional_tax, tds_monthly_paise)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        randomUUID(), by, input.name, input.basicPaise, input.hraPaise, JSON.stringify(input.allowances),
        input.epf, input.esi, input.professionalTax, input.tdsMonthlyPaise ?? null,
      ],
    );
    return toSalaryStructure(rows[0] as Record<string, unknown>);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, 'duplicate', 'a salary structure with this name exists');
    throw err;
  }
}
