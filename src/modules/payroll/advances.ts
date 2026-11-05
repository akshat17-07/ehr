import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import type { BaseFields } from '../patients/patients.js';

// Salary advances (api-list.md Advance). Money is whole paise.
// Payroll runs (#324) will deduct min(recoverPerMonthPaise, balance) each month and add it to recovered_paise.

export interface Advance extends BaseFields {
  employeeId: string;
  amountPaise: number;
  givenOn: string;
  recoverPerMonthPaise: number;
  recoveredPaise: number;
  /** amount minus recovered */
  balancePaise: number;
}

export function toAdvance(r: Record<string, unknown>): Advance {
  const amount = Number(r.amount_paise);
  const recovered = Number(r.recovered_paise);
  return {
    ...baseFields(r as unknown as BaseRow),
    employeeId: String(r.employee_id),
    amountPaise: amount,
    givenOn: r.given_on instanceof Date ? r.given_on.toISOString().slice(0, 10) : String(r.given_on).slice(0, 10),
    recoverPerMonthPaise: Number(r.recover_per_month_paise),
    recoveredPaise: recovered,
    balancePaise: amount - recovered,
  };
}

export type AdvanceRow = Omit<Advance, 'status'> & { status: 'open' | 'closed' };

/** #703: advances newest first; open: still has a balance, closed: fully recovered. */
export async function listAdvances(
  db: Queryable,
  query: PageQuery & { employeeId?: string; status?: 'open' | 'closed' },
): Promise<Page<AdvanceRow>> {
  const params: unknown[] = [];
  const where = ['voided_at IS NULL'];
  if (query.employeeId) where.push(`employee_id = $${params.push(query.employeeId)}`);
  if (query.status === 'open') where.push('recovered_paise < amount_paise');
  if (query.status === 'closed') where.push('recovered_paise >= amount_paise');
  return pageRows(db, { select: 'SELECT * FROM advances', where, params, orderBy: ['created_at', 'id'], direction: 'desc' }, query, (r) => {
    const a = toAdvance(r);
    return { ...a, status: a.balancePaise > 0 ? 'open' : 'closed' };
  });
}

const paise = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const newAdvanceBody = z
  .object({
    employeeId: z.uuid(),
    amountPaise: paise,
    givenOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d))
      .refine((d) => d <= indiaDate(), { message: 'givenOn cannot be in the future' }),
    recoverPerMonthPaise: paise,
  })
  .strict()
  .refine((b) => b.recoverPerMonthPaise <= b.amountPaise, { message: 'recoverPerMonthPaise cannot exceed amountPaise', path: ['recoverPerMonthPaise'] });
export type NewAdvance = z.infer<typeof newAdvanceBody>;

/** #323: gives an advance to an active employee. */
export async function addAdvance(db: Queryable, input: NewAdvance, by: string): Promise<Advance> {
  const emp = await db.query('SELECT active FROM employees WHERE id = $1 AND voided_at IS NULL', [input.employeeId]);
  if (!emp.rows[0]) throw new AppError(422, 'employee_unknown', 'no such employee');
  if (emp.rows[0].active !== true) throw new AppError(422, 'employee_inactive', 'this employee is not active');
  const { rows } = await db.query(
    `INSERT INTO advances (id, status, created_by, updated_by, employee_id, amount_paise, given_on, recover_per_month_paise, recovered_paise)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, 0) RETURNING *`,
    [randomUUID(), by, input.employeeId, input.amountPaise, input.givenOn, input.recoverPerMonthPaise],
  );
  return toAdvance(rows[0] as Record<string, unknown>);
}
