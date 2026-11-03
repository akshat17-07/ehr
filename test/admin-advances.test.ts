import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import type { Advance } from '../src/modules/payroll/advances.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);

async function employee(name: string, over: { active?: boolean; voided?: boolean } = {}) {
  const { rows } = await db.query(
    `INSERT INTO employees (id, status, created_by, updated_by, created_at, updated_at, name, designation, join_date, salary_structure_id, active, voided_at)
     VALUES (gen_random_uuid(), 'active', 'hr', 'hr', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', $1, 'Clerk', '2024-04-01', 's-1', $2, $3) RETURNING id`,
    [name, over.active ?? true, over.voided ? '2026-02-01T00:00:00Z' : null],
  );
  return String(rows[0]?.id);
}

describe('POST /admin/advances', () => {
  const post = (b: unknown, who = admin) =>
    app.request('/admin/advances', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }, who);
  const body = (employeeId: string, over: Record<string, unknown> = {}) => ({
    employeeId, amountPaise: 1000000, givenOn: '2026-03-01', recoverPerMonthPaise: 250000, ...over,
  });

  it('201 with zero recovered and full balance; stored; audited', async () => {
    const e = await employee('Advance Person');
    const res = await post(body(e));
    expect(res.status).toBe(201);
    const a = (await res.json()) as Advance;
    expect(a).toMatchObject({ version: 1, employeeId: e, amountPaise: 1000000, givenOn: '2026-03-01', recoverPerMonthPaise: 250000, recoveredPaise: 0, balancePaise: 1000000 });
    const row = await db.query('SELECT * FROM advances WHERE id = $1', [a.id]);
    expect(Number(row.rows[0]?.amount_paise)).toBe(1000000);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'advance' AND action = 'create' AND record_id = $1", [a.id]);
    expect(audit.rows.length).toBe(1);
  });

  it('accepts today, recover equal to amount', async () => {
    const e = await employee('Edge Person');
    expect((await post(body(e, { givenOn: indiaDate(), recoverPerMonthPaise: 1000000 }))).status).toBe(201);
  });

  it('422 for recover > amount, future date, bad money, bad date, extra field', async () => {
    const e = await employee('Bad Input Person');
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const bad: Record<string, unknown>[] = [
      { recoverPerMonthPaise: 1000001 }, { givenOn: tomorrow }, { givenOn: '2026-02-30' }, { givenOn: '01-03-2026' },
      { amountPaise: 0 }, { amountPaise: -5 }, { amountPaise: 1.5 }, { recoverPerMonthPaise: 0 }, { recoverPerMonthPaise: 10.5 },
      { amountPaise: Number.MAX_SAFE_INTEGER + 2 }, { employeeId: 'nope' }, { extra: 1 },
    ];
    for (const over of bad) expect((await post(body(e, over))).status, JSON.stringify(over)).toBe(422);
    expect((await post(undefined)).status).toBe(422);
  });

  it('422 employee_unknown for missing or voided, employee_inactive for inactive', async () => {
    const missing = await post(body('77777777-7777-4777-8777-777777777777'));
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ error: 'employee_unknown' });
    const voided = await employee('Voided Person', { voided: true });
    expect(await (await post(body(voided))).json()).toMatchObject({ error: 'employee_unknown' });
    const inactive = await employee('Inactive Person', { active: false });
    const res = await post(body(inactive));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'employee_inactive' });
  });

  it('403 without payroll.employee', async () => {
    const e = await employee('Forbidden Person');
    expect((await post(body(e), doctor)).status).toBe(403);
  });
});
