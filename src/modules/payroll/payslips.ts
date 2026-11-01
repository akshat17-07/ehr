import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';

// Payslips (api-list.md Payslip): one per employee per payroll run. Staff see their own (#6, #7) once the run is
// approved; a draft run is still being checked by HR, so its payslips are not shown.

export const DEDUCTION_KINDS = ['tds', 'epf', 'esi', 'pt', 'advance', 'other'] as const;

export interface Payslip {
  id: string;
  runId: string;
  employeeId: string;
  month: string;
  grossPaise: number;
  deductions: { kind: (typeof DEDUCTION_KINDS)[number]; paise: number }[];
  netPaise: number;
}

export const toPayslip = (r: Record<string, unknown>): Payslip => ({
  id: String(r.id),
  runId: String(r.run_id),
  employeeId: String(r.employee_id),
  month: String(r.month),
  grossPaise: Number(r.gross_paise),
  deductions: JSON.parse(String(r.deductions)) as Payslip['deductions'],
  netPaise: Number(r.net_paise),
});

const OWN = `SELECT p.* FROM payslips p
  JOIN employees e ON e.id = p.employee_id
  JOIN payroll_runs r ON r.id = p.run_id`;
const VISIBLE = ["e.user_id = $1", "r.status IN ('approved', 'paid')"];

/** The caller's payslips, newest month first; `year` keeps one calendar year. */
export function listMyPayslips(db: Queryable, userId: string, query: PageQuery & { year?: number }): Promise<Page<Payslip>> {
  const where = [...VISIBLE];
  const params: unknown[] = [userId];
  if (query.year !== undefined) {
    params.push(`${query.year}-%`);
    where.push('p.month LIKE $2');
  }
  return pageRows(db, { select: OWN, where, params, orderBy: ['p.month', 'p.id'] }, query, toPayslip);
}
