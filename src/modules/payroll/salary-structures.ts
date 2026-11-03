import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';
import { UUID } from '../users/users.js';

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

const allowanceList = z
  .array(z.object({ name, paise }).strict())
  .max(20)
  .refine((l) => new Set(l.map((a) => a.name.toLowerCase())).size === l.length, { message: 'allowance names must be unique' });

export const newSalaryStructureBody = z
  .object({
    name,
    basicPaise: paise,
    hraPaise: paise,
    allowances: allowanceList.default([]),
    epf: z.boolean(),
    esi: z.boolean(),
    professionalTax: z.boolean(),
    tdsMonthlyPaise: paise.optional(),
  })
  .strict();
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

const f = newSalaryStructureBody.shape;
export const salaryStructureChange = z
  .object({
    version: z.number().int().min(1),
    name: f.name.optional(),
    basicPaise: f.basicPaise.optional(),
    hraPaise: f.hraPaise.optional(),
    allowances: allowanceList.optional(),
    epf: f.epf.optional(),
    esi: f.esi.optional(),
    professionalTax: f.professionalTax.optional(),
    tdsMonthlyPaise: paise.nullable().optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type SalaryStructureChange = z.infer<typeof salaryStructureChange>;

/** #322: edits a structure (applies from the next payroll run; payslips keep their own amounts). Returns the saved row and audit changes. */
export async function updateSalaryStructure(
  db: Queryable,
  id: string,
  input: SalaryStructureChange,
  by: string,
): Promise<{ structure: SalaryStructure; changes: Record<string, [unknown, unknown]> }> {
  const { version, reason, ...fields } = input;
  if (Object.values(fields).every((v) => v === undefined)) throw new AppError(422, 'invalid_input', 'nothing to change');
  return withTransaction(db, async (tx) => {
    const { rows } = UUID.test(id) ? await tx.query('SELECT * FROM salary_structures WHERE id = $1 AND voided_at IS NULL', [id]) : { rows: [] };
    const old = rows[0] as Record<string, unknown> | undefined;
    if (!old) throw new AppError(404, 'not_found');
    const was = toSalaryStructure(old);
    const set: Record<string, unknown> = {};
    const changes: Record<string, [unknown, unknown]> = {};
    const put = (key: keyof SalaryStructure, col: string, now: unknown, stored: unknown = now) => {
      if (now === undefined) return;
      set[col] = stored;
      changes[key] = [was[key], now];
    };
    if (fields.name !== undefined) {
      const dup = await tx.query('SELECT 1 FROM salary_structures WHERE lower(name) = lower($1) AND id <> $2', [fields.name, id]);
      if (dup.rows.length > 0) throw new AppError(409, 'duplicate', 'a salary structure with this name exists');
    }
    put('name', 'name', fields.name);
    put('basicPaise', 'basic_paise', fields.basicPaise);
    put('hraPaise', 'hra_paise', fields.hraPaise);
    put('allowances', 'allowances', fields.allowances, fields.allowances && JSON.stringify(fields.allowances));
    put('epf', 'epf', fields.epf);
    put('esi', 'esi', fields.esi);
    put('professionalTax', 'professional_tax', fields.professionalTax);
    put('tdsMonthlyPaise', 'tds_monthly_paise', fields.tdsMonthlyPaise);
    try {
      const row = await updateRecord(tx, 'salary_structures', { id, version, by, set, ...(reason && { reason }) });
      return { structure: toSalaryStructure(row), changes };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, 'duplicate', 'a salary structure with this name exists');
      throw err;
    }
  });
}
