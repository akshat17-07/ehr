import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import { UUID } from '../users/users.js';
import { toPayslip, type DEDUCTION_KINDS, type Payslip } from './payslips.js';

// Payroll runs (api-list.md PayrollRun). #324 makes a draft run; the amounts are worked out here and nothing
// outside the new run/payslip rows changes (advances are only recovered when the run is approved, #327).

export type DeductionKind = (typeof DEDUCTION_KINDS)[number];
export interface Deduction { kind: DeductionKind; paise: number }

export interface PayrollRun {
  id: string;
  version: number;
  month: string;
  status: string;
  totalNetPaise: number;
  runBy: string;
  approvedBy: string | null;
  createdAt: string;
  /** Left out of the list. */
  payslips?: Payslip[];
}

export const MAX_RUN_EMPLOYEES = 2500;

const paise = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const newRunBody = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    adjustments: z
      .array(
        z.object({ employeeId: z.uuid(), kind: z.enum(['bonus', 'deduction']), paise, note: z.string().trim().min(1).max(200) }).strict(),
      )
      .max(500)
      .optional(),
  })
  .strict();
export type NewRun = z.infer<typeof newRunBody>;

export interface PayInput {
  month: string; // YYYY-MM
  basicPaise: number;
  hraPaise: number;
  allowances: { paise: number }[];
  epf: boolean;
  esi: boolean;
  professionalTax: boolean;
  tdsMonthlyPaise: number | null;
  bonusPaise?: number;
  advanceRecoveryPaise?: number;
  otherDeductionPaise?: number;
}

const EPF_WAGE_CAP = 1500000;
const ESI_GROSS_LIMIT = 2100000;

/** Madhya Pradesh professional tax for one month; slabs are on annual gross. */
export function madhyaPradeshPt(grossPaise: number, month: string): number {
  const annual = grossPaise * 12;
  const march = month.endsWith('-03');
  if (annual <= 22500000) return 0;
  if (annual <= 30000000) return 12500;
  if (annual <= 40000000) return march ? 17400 : 16600;
  return march ? 21200 : 20800;
}

/** Pure pay calculation for one employee. Deductions are only listed when non-zero. */
export function calculatePay(i: PayInput): { grossPaise: number; deductions: Deduction[]; netPaise: number } {
  const grossPaise = i.basicPaise + i.hraPaise + i.allowances.reduce((s, a) => s + a.paise, 0) + (i.bonusPaise ?? 0);
  const all: Deduction[] = [
    { kind: 'epf', paise: i.epf ? Math.floor((Math.min(i.basicPaise, EPF_WAGE_CAP) * 12 + 50) / 100) : 0 },
    // 0.75% of gross, rounded up to a whole rupee
    { kind: 'esi', paise: i.esi && grossPaise <= ESI_GROSS_LIMIT ? Math.floor((grossPaise * 75 + 999999) / 1000000) * 100 : 0 },
    { kind: 'pt', paise: i.professionalTax ? madhyaPradeshPt(grossPaise, i.month) : 0 },
    { kind: 'tds', paise: i.tdsMonthlyPaise ?? 0 },
    { kind: 'advance', paise: i.advanceRecoveryPaise ?? 0 },
    { kind: 'other', paise: i.otherDeductionPaise ?? 0 },
  ];
  const deductions = all.filter((d) => d.paise > 0);
  return { grossPaise, deductions, netPaise: grossPaise - deductions.reduce((s, d) => s + d.paise, 0) };
}

export function toRun(r: Record<string, unknown>, payslips?: Payslip[]): PayrollRun {
  return {
    id: String(r.id),
    version: Number(r.version),
    month: String(r.month),
    status: String(r.status),
    totalNetPaise: Number(r.total_net_paise),
    runBy: String(r.run_by),
    approvedBy: r.approved_by == null ? null : String(r.approved_by),
    createdAt: new Date(r.created_at as string | Date).toISOString(),
    ...(payslips && { payslips }),
  };
}

export const runsQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }).strict();
export type RunsQuery = z.infer<typeof runsQuery>;

/** #325: runs newest month first, without payslips. */
export async function listPayrollRuns(db: Queryable, query: RunsQuery): Promise<PayrollRun[]> {
  const { rows } = query.year === undefined
    ? await db.query('SELECT * FROM payroll_runs WHERE voided_at IS NULL ORDER BY month DESC, id')
    : await db.query('SELECT * FROM payroll_runs WHERE voided_at IS NULL AND month LIKE $1 ORDER BY month DESC, id', [`${query.year}-%`]);
  return rows.map((r) => toRun(r as Record<string, unknown>));
}

/** #326: one run with its payslips, by employee name. */
export async function getPayrollRun(db: Queryable, id: string): Promise<PayrollRun> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM payroll_runs WHERE id = $1 AND voided_at IS NULL', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found');
  const slips = await db.query(
    `SELECT p.* FROM payslips p LEFT JOIN employees e ON e.id = p.employee_id WHERE p.run_id = $1 ORDER BY e.name, p.id`,
    [id],
  );
  return toRun(rows[0] as Record<string, unknown>, slips.rows.map((r) => toPayslip(r as Record<string, unknown>)));
}

/** #324: makes a draft run for `month` with a payslip for every active employee joined by month end. */
export async function createPayrollRun(db: Queryable, input: NewRun, by: string): Promise<PayrollRun> {
  const { month } = input;
  if (month > indiaDate().slice(0, 7)) throw new AppError(422, 'invalid_month', 'the month cannot be in the future');
  const [y, m] = month.split('-').map(Number) as [number, number];
  const monthEnd = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;

  const exists = await db.query('SELECT 1 FROM payroll_runs WHERE month = $1', [month]);
  if (exists.rows.length > 0) throw new AppError(409, 'run_exists', 'a payroll run already exists for this month');

  const emps = await db.query(
    `SELECT e.id, s.basic_paise, s.hra_paise, s.allowances, s.epf, s.esi, s.professional_tax, s.tds_monthly_paise
     FROM employees e LEFT JOIN salary_structures s ON s.id::text = e.salary_structure_id
     WHERE e.voided_at IS NULL AND e.active = true AND e.join_date <= $1
     ORDER BY e.name, e.id`,
    [monthEnd],
  );
  if (emps.rows.length === 0) throw new AppError(422, 'no_employees', 'no active employees for this month');
  if (emps.rows.length > MAX_RUN_EMPLOYEES) throw new AppError(422, 'too_many_employees', `a run is limited to ${MAX_RUN_EMPLOYEES} employees`);

  const ids = new Set(emps.rows.map((r) => String(r.id)));
  const bonus = new Map<string, number>();
  const other = new Map<string, number>();
  for (const a of input.adjustments ?? []) {
    if (!ids.has(a.employeeId)) throw new AppError(422, 'employee_not_in_run', `employee ${a.employeeId} is not in this run`);
    const target = a.kind === 'bonus' ? bonus : other;
    target.set(a.employeeId, (target.get(a.employeeId) ?? 0) + a.paise);
  }

  const adv = await db.query(
    `SELECT employee_id, recover_per_month_paise, amount_paise - recovered_paise AS balance FROM advances
     WHERE status = 'active' AND voided_at IS NULL AND given_on <= $1 AND amount_paise - recovered_paise > 0`,
    [monthEnd],
  );
  const recovery = new Map<string, number>();
  for (const a of adv.rows) {
    const id = String(a.employee_id);
    recovery.set(id, (recovery.get(id) ?? 0) + Math.min(Number(a.recover_per_month_paise), Number(a.balance)));
  }

  const slips = emps.rows.map((r) => {
    const id = String(r.id);
    if (r.basic_paise == null) throw new AppError(422, 'structure_missing', `employee ${id} has no salary structure`);
    const pay = calculatePay({
      month,
      basicPaise: Number(r.basic_paise),
      hraPaise: Number(r.hra_paise),
      allowances: JSON.parse(String(r.allowances)) as { paise: number }[],
      epf: r.epf === true,
      esi: r.esi === true,
      professionalTax: r.professional_tax === true,
      tdsMonthlyPaise: r.tds_monthly_paise == null ? null : Number(r.tds_monthly_paise),
      bonusPaise: bonus.get(id) ?? 0,
      advanceRecoveryPaise: recovery.get(id) ?? 0,
      otherDeductionPaise: other.get(id) ?? 0,
    });
    if (pay.netPaise < 0) throw new AppError(422, 'negative_net', `net pay would be negative for employee ${id}`);
    return { id, ...pay };
  });
  const total = slips.reduce((s, p) => s + p.netPaise, 0);

  return withTransaction(db, async (tx) => {
    const runId = randomUUID();
    let run;
    try {
      run = (
        await tx.query(
          `INSERT INTO payroll_runs (id, status, created_by, updated_by, month, total_net_paise, run_by)
           VALUES ($1, 'draft', $2, $2, $3, $4, $2) RETURNING *`,
          [runId, by, month, total],
        )
      ).rows[0] as Record<string, unknown>;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new AppError(409, 'run_exists', 'a payroll run already exists for this month');
      throw err;
    }
    const payslips: Payslip[] = [];
    for (const s of slips) {
      const { rows } = await tx.query(
        `INSERT INTO payslips (id, status, created_by, updated_by, run_id, employee_id, month, gross_paise, deductions, net_paise)
         VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [randomUUID(), by, runId, s.id, month, s.grossPaise, JSON.stringify(s.deductions), s.netPaise],
      );
      payslips.push(toPayslip(rows[0] as Record<string, unknown>));
    }
    return toRun(run, payslips);
  });
}
