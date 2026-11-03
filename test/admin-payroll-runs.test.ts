import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { calculatePay, madhyaPradeshPt, type PayrollRun } from '../src/modules/payroll/runs.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);

const AT = "'2026-01-01T00:00:00Z'";
async function structure(name: string, o: { basic: number; hra: number; allowances?: number[]; epf?: boolean; esi?: boolean; pt?: boolean; tds?: number | null }) {
  const { rows } = await db.query(
    `INSERT INTO salary_structures (id, status, created_by, updated_by, created_at, updated_at, name, basic_paise, hra_paise, allowances, epf, esi, professional_tax, tds_monthly_paise)
     VALUES (gen_random_uuid(), 'active', 'hr', 'hr', ${AT}, ${AT}, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [name, o.basic, o.hra, JSON.stringify((o.allowances ?? []).map((paise, i) => ({ name: `a${i}`, paise }))), o.epf ?? false, o.esi ?? false, o.pt ?? false, o.tds ?? null],
  );
  return String(rows[0]?.id);
}
async function employee(name: string, structureId: string, joinDate = '2024-04-01', userId: string | null = null) {
  const { rows } = await db.query(
    `INSERT INTO employees (id, status, created_by, updated_by, created_at, updated_at, user_id, name, designation, join_date, salary_structure_id, active)
     VALUES (gen_random_uuid(), 'active', 'hr', 'hr', ${AT}, ${AT}, $1, $2, 'Clerk', $3, $4, true) RETURNING id`,
    [userId, name, joinDate, structureId],
  );
  return String(rows[0]?.id);
}
async function advance(employeeId: string, amount: number, recovered: number, perMonth: number, givenOn = '2026-01-10') {
  const { rows } = await db.query(
    `INSERT INTO advances (id, status, created_by, updated_by, created_at, updated_at, employee_id, amount_paise, given_on, recover_per_month_paise, recovered_paise)
     VALUES (gen_random_uuid(), 'active', 'hr', 'hr', ${AT}, ${AT}, $1, $2, $3, $4, $5) RETURNING id`,
    [employeeId, amount, givenOn, perMonth, recovered],
  );
  return String(rows[0]?.id);
}

const post = (b: unknown, who = admin) =>
  app.request('/admin/payroll/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }, who);

beforeEach(async () => {
  await db.query('UPDATE employees SET active = false');
});

describe('calculatePay', () => {
  const base = { month: '2026-04', basicPaise: 3000000, hraPaise: 0, allowances: [], epf: false, esi: false, professionalTax: false, tdsMonthlyPaise: null };

  it.each([
    // [gross per month, month, pt]
    [1875000, '2026-04', 0], // annual 22,500,000: top of the nil slab
    [1875001, '2026-04', 12500],
    [2500000, '2026-04', 12500], // annual 30,000,000
    [2500001, '2026-04', 16600],
    [2500001, '2026-03', 17400],
    [3333333, '2026-04', 16600], // annual 39,999,996
    [3333334, '2026-04', 20800], // annual 40,000,008
    [3333334, '2026-03', 21200],
    [1875000, '2026-03', 0],
  ])('PT on gross %i in %s is %i', (gross, month, pt) => {
    expect(madhyaPradeshPt(gross, month)).toBe(pt);
  });

  it('ESI applies at gross 2100000 (ceil to rupee) but not at 2100001', () => {
    const at = calculatePay({ ...base, basicPaise: 2100000, esi: true });
    expect(at.deductions).toEqual([{ kind: 'esi', paise: 15800 }]); // 15750 -> 158 rupees
    const over = calculatePay({ ...base, basicPaise: 2100001, esi: true });
    expect(over.deductions).toEqual([]);
  });

  it('ESI exact rupee does not round up', () => {
    expect(calculatePay({ ...base, basicPaise: 2000000, esi: true }).deductions).toEqual([{ kind: 'esi', paise: 15000 }]);
  });

  it('EPF is 12% of basic capped at 1500000', () => {
    expect(calculatePay({ ...base, basicPaise: 1000000, epf: true }).deductions).toEqual([{ kind: 'epf', paise: 120000 }]);
    expect(calculatePay({ ...base, basicPaise: 1500000, epf: true }).deductions).toEqual([{ kind: 'epf', paise: 180000 }]);
    expect(calculatePay({ ...base, basicPaise: 5000000, epf: true }).deductions).toEqual([{ kind: 'epf', paise: 180000 }]);
    expect(calculatePay({ ...base, basicPaise: 1000001, epf: true }).deductions).toEqual([{ kind: 'epf', paise: 120000 }]); // 120000.12 rounds down
  });

  it('adds bonus to gross, orders deductions, skips zeros', () => {
    const r = calculatePay({
      ...base, basicPaise: 3000000, hraPaise: 1000000, allowances: [{ paise: 500000 }], epf: true, professionalTax: true, tdsMonthlyPaise: 10000,
      bonusPaise: 100000, advanceRecoveryPaise: 50000, otherDeductionPaise: 1000,
    });
    expect(r.grossPaise).toBe(4600000);
    expect(r.deductions.map((d) => d.kind)).toEqual(['epf', 'pt', 'tds', 'advance', 'other']);
    expect(r.netPaise).toBe(4600000 - (180000 + 20800 + 10000 + 50000 + 1000));
  });
});

describe('POST /admin/payroll/runs', () => {
  it('201 draft with computed payslips; advances not changed; audited without amounts', async () => {
    const big = await structure('Big', { basic: 3000000, hra: 1200000, allowances: [300000], epf: true, esi: true, pt: true, tds: 50000 });
    const small = await structure('Small', { basic: 1000000, hra: 400000, epf: true, esi: true, pt: true });
    const e1 = await employee('Alpha Big', big);
    const e2 = await employee('Beta Small', small);
    await employee('Gamma Later', small, '2026-06-01'); // joins after the month
    const adv = await advance(e1, 1000000, 900000, 250000); // balance 100000 < 250000
    const future = await advance(e1, 1000000, 0, 100000, '2026-06-15'); // given after the month

    const res = await post({
      month: '2026-05',
      adjustments: [
        { employeeId: e1, kind: 'bonus', paise: 100000, note: 'Diwali' },
        { employeeId: e1, kind: 'deduction', paise: 20000, note: 'Loss of kit' },
      ],
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as PayrollRun;
    expect(run).toMatchObject({ version: 1, month: '2026-05', status: 'draft', runBy: 'dev-admin', approvedBy: null, totalNetPaise: 4229200 + 1269500 });
    expect(run.payslips).toHaveLength(2);
    const p1 = run.payslips.find((p) => p.employeeId === e1);
    expect(p1).toMatchObject({
      runId: run.id, month: '2026-05', grossPaise: 4600000, netPaise: 4229200,
      deductions: [{ kind: 'epf', paise: 180000 }, { kind: 'pt', paise: 20800 }, { kind: 'tds', paise: 50000 }, { kind: 'advance', paise: 100000 }, { kind: 'other', paise: 20000 }],
    });
    const p2 = run.payslips.find((p) => p.employeeId === e2);
    expect(p2).toMatchObject({ grossPaise: 1400000, netPaise: 1269500, deductions: [{ kind: 'epf', paise: 120000 }, { kind: 'esi', paise: 10500 }] });

    const stored = await db.query('SELECT status, total_net_paise FROM payroll_runs WHERE id = $1', [run.id]);
    expect(stored.rows[0]).toMatchObject({ status: 'draft' });
    expect(Number(stored.rows[0]?.total_net_paise)).toBe(5498700);
    const rec = await db.query('SELECT id, recovered_paise FROM advances WHERE id IN ($1, $2)', [adv, future]);
    expect(Object.fromEntries(rec.rows.map((r) => [r.id, Number(r.recovered_paise)]))).toEqual({ [adv]: 900000, [future]: 0 });

    const audit = await db.query("SELECT changes FROM audit_events WHERE record_type = 'payroll_run' AND record_id = $1", [run.id]);
    expect(audit.rows.length).toBe(1);
    const text = JSON.stringify(audit.rows[0]);
    expect(text).toContain('2026-05');
    expect(text).not.toContain('4229200');
    expect(text).not.toContain('1269500');
  });

  it('uses the March professional tax and sums several advances', async () => {
    const s = await structure('March', { basic: 4000000, hra: 0, pt: true });
    const e = await employee('March Person', s);
    await advance(e, 500000, 0, 30000);
    await advance(e, 500000, 480000, 30000); // balance 20000
    await advance(e, 500000, 500000, 30000); // fully recovered
    const run = (await (await post({ month: '2026-03' })).json()) as PayrollRun;
    expect(run.payslips[0]).toMatchObject({ grossPaise: 4000000, deductions: [{ kind: 'pt', paise: 21200 }, { kind: 'advance', paise: 50000 }], netPaise: 3928800 });
  });

  it('409 run_exists for a month that already has a run, whatever its status', async () => {
    const s = await structure('Dup', { basic: 100000, hra: 0 });
    await employee('Dup Person', s);
    expect((await post({ month: '2026-07' })).status).toBe(201);
    const again = await post({ month: '2026-07' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'run_exists' });
    await db.query("UPDATE payroll_runs SET status = 'paid' WHERE month = '2026-07'");
    expect((await post({ month: '2026-07' })).status).toBe(409);
  });

  it('422 invalid_month for a future month; current month is allowed', async () => {
    const s = await structure('Months', { basic: 100000, hra: 0 });
    await employee('Month Person', s, '2020-01-01');
    const cur = indiaDate().slice(0, 7);
    const [y, m] = cur.split('-').map(Number) as [number, number];
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    const res = await post({ month: next });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'invalid_month' });
    expect((await post({ month: cur })).status).toBe(201);
  });

  it('422 no_employees when nobody is active and joined', async () => {
    const res = await post({ month: '2019-01' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'no_employees' });
    const s = await structure('Late', { basic: 100000, hra: 0 });
    await employee('Late Joiner', s, '2019-02-01');
    expect(await (await post({ month: '2019-01' })).json()).toMatchObject({ error: 'no_employees' });
  });

  it('422 employee_not_in_run, negative_net, and bad input; nothing stored on failure', async () => {
    const s = await structure('Small2', { basic: 100000, hra: 0 });
    const e = await employee('Neg Person', s);
    const stranger = '77777777-7777-4777-8777-777777777777';
    const outsider = await post({ month: '2026-08', adjustments: [{ employeeId: stranger, kind: 'bonus', paise: 1, note: 'x' }] });
    expect(outsider.status).toBe(422);
    expect(await outsider.json()).toMatchObject({ error: 'employee_not_in_run' });

    const neg = await post({ month: '2026-08', adjustments: [{ employeeId: e, kind: 'deduction', paise: 100001, note: 'too much' }] });
    expect(neg.status).toBe(422);
    const negBody = (await neg.json()) as { error: string; message: string };
    expect(negBody.error).toBe('negative_net');
    expect(negBody.message).toContain(e);
    expect((await db.query("SELECT 1 FROM payroll_runs WHERE month = '2026-08'")).rows.length).toBe(0);

    const adj = { employeeId: e, kind: 'bonus', paise: 5, note: 'ok' };
    const bad: unknown[] = [
      {}, { month: '2026-13' }, { month: '2026-00' }, { month: '26-05' }, { month: '2026-05', extra: 1 },
      { month: '2026-08', adjustments: [{ ...adj, paise: 0 }] }, { month: '2026-08', adjustments: [{ ...adj, kind: 'other' }] },
      { month: '2026-08', adjustments: [{ ...adj, note: '' }] }, { month: '2026-08', adjustments: [{ ...adj, employeeId: 'x' }] },
      { month: '2026-08', adjustments: Array.from({ length: 501 }, () => adj) },
    ];
    for (const b of bad) expect((await post(b)).status, JSON.stringify(b)).toBe(422);
    expect((await post(undefined)).status).toBe(422);
  });

  it('403 without payroll.run', async () => {
    expect((await post({ month: '2026-09' }, doctor)).status).toBe(403);
  });

  it('a draft run stays hidden from GET /staff/me/payslips', async () => {
    const s = await structure('Hidden', { basic: 100000, hra: 0 });
    await employee('Staff Nurse', s, '2020-01-01', 'dev-nurse');
    const run = (await (await post({ month: '2026-10' })).json()) as PayrollRun;
    const nurse = asStaff('dev-nurse', ['nurse']);
    const mine = async () => ((await (await app.request('/staff/me/payslips', {}, nurse)).json()) as { items: { runId: string }[] }).items;
    expect((await mine()).map((p) => p.runId)).not.toContain(run.id);
    await db.query("UPDATE payroll_runs SET status = 'approved' WHERE id = $1", [run.id]);
    expect((await mine()).map((p) => p.runId)).toContain(run.id);
  });
});
