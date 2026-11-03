import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import type { SalaryStructure } from '../src/modules/payroll/salary-structures.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);

async function structure(name: string, over: { allowances?: unknown; tds?: number | null; voided?: boolean } = {}) {
  const { rows } = await db.query(
    `INSERT INTO salary_structures (id, status, created_by, updated_by, created_at, updated_at, name, basic_paise, hra_paise, allowances, epf, esi, professional_tax, tds_monthly_paise, voided_at)
     VALUES (gen_random_uuid(), 'active', 'hr', 'hr', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', $1, 3000000, 1200000, $2, true, false, true, $3, $4) RETURNING id`,
    [name, JSON.stringify(over.allowances ?? []), over.tds ?? null, over.voided ? '2026-02-01T00:00:00Z' : null],
  );
  return String(rows[0]?.id);
}

describe('GET /admin/salary-structures', () => {
  it('lists by name, leaves out voided, parses allowances and paise', async () => {
    const b = await structure('Zeta Grade', { allowances: [{ name: 'Travel', paise: 150000 }], tds: 250000 });
    const a = await structure('Alpha Grade');
    await structure('Mid Grade', { voided: true });
    const res = await app.request('/admin/salary-structures', {}, admin);
    expect(res.status).toBe(200);
    const items = (await res.json()) as SalaryStructure[];
    expect(items.map((s) => s.name)).toEqual(['Alpha Grade', 'Zeta Grade']);
    expect(items[0]).toMatchObject({ id: a, version: 1, basicPaise: 3000000, hraPaise: 1200000, allowances: [], epf: true, esi: false, professionalTax: true, tdsMonthlyPaise: null });
    expect(items[1]).toMatchObject({ id: b, allowances: [{ name: 'Travel', paise: 150000 }], tdsMonthlyPaise: 250000 });
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'salary_structure' AND action = 'view'");
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('403 without payroll.employee', async () => {
    expect((await app.request('/admin/salary-structures', {}, doctor)).status).toBe(403);
  });
});

describe('POST /admin/salary-structures', () => {
  const post = (b: unknown, who = admin) =>
    app.request('/admin/salary-structures', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }, who);
  const body = (over: Record<string, unknown> = {}) => ({ name: ' Grade P1 ', basicPaise: 4000000, hraPaise: 1600000, epf: true, esi: false, professionalTax: true, ...over });

  it('201, stores values, defaults allowances to [], audits', async () => {
    const res = await post(body());
    expect(res.status).toBe(201);
    const s = (await res.json()) as SalaryStructure;
    expect(s).toMatchObject({ version: 1, name: 'Grade P1', basicPaise: 4000000, hraPaise: 1600000, allowances: [], epf: true, esi: false, professionalTax: true, tdsMonthlyPaise: null });
    const row = await db.query('SELECT * FROM salary_structures WHERE id = $1', [s.id]);
    expect(row.rows[0]).toMatchObject({ name: 'Grade P1', allowances: '[]' });
    expect(Number(row.rows[0]?.basic_paise)).toBe(4000000);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'salary_structure' AND action = 'create' AND record_id = $1", [s.id]);
    expect(audit.rows.length).toBe(1);
  });

  it('stores allowances and tds', async () => {
    const res = await post(body({ name: 'Grade P2', allowances: [{ name: 'Travel', paise: 150000 }], tdsMonthlyPaise: 250000 }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ allowances: [{ name: 'Travel', paise: 150000 }], tdsMonthlyPaise: 250000 });
  });

  it('409 duplicate name, also in different case', async () => {
    expect((await post(body({ name: 'Grade P3' }))).status).toBe(201);
    for (const name of ['Grade P3', 'GRADE p3']) {
      const res = await post(body({ name }));
      expect(res.status, name).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'duplicate' });
    }
  });

  it('422 for bad money, duplicate allowance names, extra fields, bad name', async () => {
    const bad: Record<string, unknown>[] = [
      { basicPaise: -1 }, { hraPaise: 1.5 }, { basicPaise: '100' }, { tdsMonthlyPaise: -5 }, { basicPaise: Number.MAX_SAFE_INTEGER + 2 },
      { allowances: [{ name: 'A', paise: -1 }] }, { allowances: [{ name: 'A', paise: 1.2 }] },
      { allowances: [{ name: 'Travel', paise: 1 }, { name: 'travel', paise: 2 }] },
      { allowances: Array.from({ length: 21 }, (_, i) => ({ name: `A${i}`, paise: 1 })) },
      { name: '  ' }, { name: 'x'.repeat(101) }, { extra: 1 }, { epf: 'yes' },
    ];
    for (const over of bad) expect((await post(body({ name: 'Bad', ...over }))).status, JSON.stringify(over)).toBe(422);
    expect((await post(undefined)).status).toBe(422);
  });

  it('403 without payroll.employee', async () => {
    expect((await post(body({ name: 'Nope' }), doctor)).status).toBe(403);
  });
});
