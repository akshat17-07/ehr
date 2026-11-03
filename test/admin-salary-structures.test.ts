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
