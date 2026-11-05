import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// Tasks 704 (approval amounts), 705 (hospital limits, drug ceiling), 708 (insurers and TPAs for insurance).

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const nurse = asStaff('dev-nurse', ['nurse']);
const insurance = asStaff('dev-insurance', ['insurance']);
const gp = asStaff('dev-gp', ['gp']);
const get = async (path: string, who = admin) => {
  const res = await app.request(path, {}, who);
  return { status: res.status, body: (await res.json()) as never };
};

describe('#704 approvals hub amountPaise', () => {
  it('refund, discount and payroll carry paise; other kinds null', async () => {
    const patient = seedId('9a710000', 1);
    const ins = async (table: string, columns: Record<string, unknown>, status = 'pending') => {
      const names = Object.keys(columns);
      await db.query(
        `INSERT INTO ${table} (id, status, created_by, updated_by, ${names.join(', ')}) VALUES ($1, $2, 'dev-billing', 'dev-billing', ${names.map((_, i) => `$${i + 3}`).join(', ')})`,
        [randomUUID(), status, ...Object.values(columns)],
      );
    };
    await ins('refunds', { bill_id: randomUUID(), patient_id: patient, amount_paise: 250000, mode: 'cash', reason: 'r' });
    await ins('discounts', { bill_id: randomUUID(), amount_paise: 50000, reason: 'd' });
    await ins('payroll_runs', { month: '2026-10', total_net_paise: 12345600, run_by: 'dev-billing' }, 'draft');
    await ins('access_requests', { patient_id: patient, requested_by: 'dev-billing', reason: 'a' });
    const items = (await get('/admin/approvals')).body as { kind: string; amountPaise: number | null }[];
    const by = (k: string) => items.filter((i) => i.kind === k).map((i) => i.amountPaise);
    expect(by('refund')).toContain(250000);
    expect(by('discount')).toContain(50000);
    expect(by('payroll')).toContain(12345600);
    expect(by('access_request')).toEqual([null]);
  });
});

describe('#705 hospital limits and drug ceiling', () => {
  it('limits only for settings.manage', async () => {
    const a = (await get('/staff/hospital', admin)).body as Record<string, unknown>;
    expect(typeof a.refundLimitPaise).toBe('number');
    expect(typeof a.discountLimitPaise).toBe('number');
    const n = (await get('/staff/hospital', nurse)).body as Record<string, unknown>;
    expect(n).not.toHaveProperty('refundLimitPaise');
    expect(n).not.toHaveProperty('discountLimitPaise');
  });
  it('ceilingPaise on drug list and detail, null when none', async () => {
    const id = String((await db.query("SELECT id FROM drugs WHERE name = 'Paracetamol'")).rows[0]!.id);
    await db.query('UPDATE drugs SET ceiling_paise = NULL WHERE id = $1', [id]);
    expect((await get(`/staff/drugs/${id}`, nurse)).body).toHaveProperty('ceilingPaise', null);
    await db.query('UPDATE drugs SET ceiling_paise = 150 WHERE id = $1', [id]);
    expect((await get(`/staff/drugs/${id}`, nurse)).body).toHaveProperty('ceilingPaise', 150);
    const list = (await get('/staff/drugs?q=paracetamol', nurse)).body as { id: string; ceilingPaise: number | null }[];
    expect(list.find((d) => d.id === id)?.ceilingPaise).toBe(150);
  });
});

describe('#708 /other/insurance insurers and tpas', () => {
  it('same answer as /staff; other groups get 403', async () => {
    for (const p of ['insurers', 'tpas']) {
      const staff = await get(`/staff/${p}`, admin);
      const ins = await get(`/other/insurance/${p}`, insurance);
      expect(ins.status).toBe(200);
      expect(ins.body).toEqual(staff.body);
      expect((ins.body as unknown[]).length).toBeGreaterThan(0);
      expect((await get(`/other/insurance/${p}`, gp)).status).toBe(403);
    }
  });
});
