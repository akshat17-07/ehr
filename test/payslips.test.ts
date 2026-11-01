import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import type { Payslip } from '../src/modules/payroll/payslips.js';

const db = await openLocalDb();
const app = createApp({ db: async () => db });

async function list(query = '', sub = 'nurse-1') {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': '[nurse]' };
  const env = { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
  const res = await app.request(`/staff/me/payslips${query}`, {}, env);
  return { status: res.status, body: (await res.json()) as { items: Payslip[]; nextCursor?: string } };
}

const base = "gen_random_uuid(), 'active', 'hr', 'hr'";
async function employee(userId: string | null) {
  const { rows } = await db.query(
    `INSERT INTO employees (id, status, created_by, updated_by, user_id, name, designation, join_date, pan_enc, bank_enc, salary_structure_id, active)
     VALUES (${base}, $1, 'Name', 'Staff nurse', '2024-04-01', 'enc', 'enc', 's-1', true) RETURNING id`,
    [userId],
  );
  return String(rows[0]?.id);
}
async function run(month: string, status: string) {
  const { rows } = await db.query(
    `INSERT INTO payroll_runs (id, status, created_by, updated_by, month, total_net_paise, run_by) VALUES (gen_random_uuid(), $1, 'hr', 'hr', $2, 0, 'hr') RETURNING id`,
    [status, month],
  );
  return String(rows[0]?.id);
}
async function payslip(runId: string, employeeId: string, month: string) {
  await db.query(
    `INSERT INTO payslips (id, status, created_by, updated_by, run_id, employee_id, month, gross_paise, deductions, net_paise)
     VALUES (${base}, $1, $2, $3, 3500000, $4, 3300000)`,
    [runId, employeeId, month, JSON.stringify([{ kind: 'epf', paise: 180000 }, { kind: 'pt', paise: 20000 }])],
  );
}

describe('GET /staff/me/payslips', () => {
  it('lists own payslips from approved or paid runs, newest month first', async () => {
    const me = await employee('nurse-1');
    const other = await employee('doc-1');
    const months: [string, string][] = [['2025-12', 'paid'], ['2026-01', 'paid'], ['2026-02', 'approved'], ['2026-03', 'draft']];
    for (const [month, status] of months) {
      const r = await run(month, status);
      await payslip(r, me, month);
      await payslip(r, other, month);
    }

    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((p) => p.month)).toEqual(['2026-02', '2026-01', '2025-12']);
    expect(body.items[0]).toMatchObject({
      employeeId: me,
      grossPaise: 3500000,
      netPaise: 3300000,
      deductions: [{ kind: 'epf', paise: 180000 }, { kind: 'pt', paise: 20000 }],
    });
  });

  it('filters by year and pages', async () => {
    expect((await list('?year=2025')).body.items.map((p) => p.month)).toEqual(['2025-12']);
    const first = await list('?limit=2');
    const second = await list(`?limit=2&cursor=${first.body.nextCursor}`);
    expect([...first.body.items, ...second.body.items].map((p) => p.month)).toEqual(['2026-02', '2026-01', '2025-12']);
    expect((await list('?year=26')).status).toBe(422);
  });

  it('is empty for staff with no employee record', async () => {
    expect((await list('', 'gp-less')).body.items).toEqual([]);
  });
});
