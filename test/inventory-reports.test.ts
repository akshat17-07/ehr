import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });
const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);
const get = (path: string, who = admin) => app.request(path, {}, who);

const day = (offset: number) => indiaDate(new Date(Date.now() + offset * 86_400_000));
const mkItem = async (name: string, kind = 'consumable') => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO items (id, status, created_by, updated_by, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise, active)
     VALUES ($1, 'active', 'x', 'x', $2, $3, 'box', 1, '3005', 12, 5000, true)`,
    [id, name, kind],
  );
  return id;
};
const mkBatch = async (itemId: string, batchNo: string, expiry: string, qty: number, cost: number, mrp: number) => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO batches (id, status, created_by, updated_by, item_id, batch_no, expiry, cost_paise, mrp_paise, qty_on_hand)
     VALUES ($1, 'active', 'x', 'x', $2, $3, $4, $5, $6, $7)`,
    [id, itemId, batchNo, expiry, cost, mrp, qty],
  );
  return id;
};

const valA = await mkItem('Rep Valuation A');
const valB = await mkItem('Rep Valuation B', 'implant');
const bA1 = await mkBatch(valA, 'VA1', day(400), 10, 100, 150);
await mkBatch(valA, 'VA2', day(400), 5, 200, 250);
await mkBatch(valB, 'VB1', day(400), 2, 1000, 1500);
await mkBatch(valB, 'VB0', day(400), 0, 1000, 1500);

describe('GET /admin/reports/stock-valuation', () => {
  type Res = { on: string; rows: { item: { id: string }; qty: number; costValuePaise: number; mrpValuePaise: number }[]; totals: { qty: number; costValuePaise: number; mrpValuePaise: number } };
  it('qty x cost per item, with totals; filtered by kind', async () => {
    const res = await get('/admin/reports/stock-valuation?kind=consumable');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Res;
    const a = body.rows.find((r) => r.item.id === valA);
    expect(a).toMatchObject({ qty: 15, costValuePaise: 2000, mrpValuePaise: 2750 });
    expect(body.rows.find((r) => r.item.id === valB)).toBeUndefined();
    expect(body.totals.costValuePaise).toBe(body.rows.reduce((s, r) => s + r.costValuePaise, 0));
    const all = (await (await get('/admin/reports/stock-valuation')).json()) as Res;
    expect(all.rows.find((r) => r.item.id === valB)).toMatchObject({ qty: 2, costValuePaise: 2000 });
  });

  it('on a past day, stock received since is taken back out', async () => {
    await db.query(`INSERT INTO grns (id, status, created_by, updated_by, supplier_id, invoice_no, invoice_date, lines, received_by) VALUES ($1, 'active', 'x', 'x', $2, 'REP/1', $3, $4, 'x')`, [
      randomUUID(),
      randomUUID(),
      day(0),
      JSON.stringify([{ itemId: valA, batchId: bA1, batchNo: 'VA1', qty: 4, freeQty: 1 }]),
    ]);
    const past = (await (await get(`/admin/reports/stock-valuation?on=${day(-1)}`)).json()) as Res;
    expect(past.rows.find((r) => r.item.id === valA)).toMatchObject({ qty: 10, costValuePaise: 1500 });
    expect((await get(`/admin/reports/stock-valuation?on=${day(3)}`)).status).toBe(422);
  });

  it('403 for a doctor; 422 for a bad kind', async () => {
    expect((await get('/admin/reports/stock-valuation', doctor)).status).toBe(403);
    expect((await get('/admin/reports/stock-valuation?kind=food')).status).toBe(422);
  });
});

describe('GET /admin/reports/expiry', () => {
  it('stock expiring within the window or already expired, first to expire first', async () => {
    const item = await mkItem('Rep Expiry');
    await mkBatch(item, 'E-FAR', day(200), 5, 10, 20);
    await mkBatch(item, 'E-SOON', day(30), 5, 10, 20);
    await mkBatch(item, 'E-OLD', day(-5), 3, 10, 20);
    await mkBatch(item, 'E-EMPTY', day(10), 0, 10, 20);
    const rows = (await (await get('/admin/reports/expiry')).json()) as { item: { id: string }; batch: { batchNo: string }; expiry: string; qty: number; expired: boolean }[];
    const mine = rows.filter((r) => r.item.id === item);
    expect(mine.map((r) => [r.batch.batchNo, r.qty, r.expired])).toEqual([['E-OLD', 3, true], ['E-SOON', 5, false]]);
    expect([...rows].map((r) => r.expiry)).toEqual([...rows].map((r) => r.expiry).sort());
    const wide = (await (await get('/admin/reports/expiry?days=365')).json()) as typeof rows;
    expect(wide.filter((r) => r.item.id === item).map((r) => r.batch.batchNo)).toEqual(['E-OLD', 'E-SOON', 'E-FAR']);
  });

  it('403 for a doctor; 422 over 365 days', async () => {
    expect((await get('/admin/reports/expiry', doctor)).status).toBe(403);
    expect((await get('/admin/reports/expiry?withinDays=366')).status).toBe(422);
  });
});

describe('GET /admin/reports/stock-variance', () => {
  it('count differences with their value; matching lines are left out', async () => {
    const item = await mkItem('Rep Variance');
    const lost = await mkBatch(item, 'V1', day(300), 8, 250, 300);
    const same = await mkBatch(item, 'V2', day(300), 5, 250, 300);
    const countId = randomUUID();
    await db.query(`INSERT INTO stock_counts (id, status, created_by, updated_by, lines, created_at) VALUES ($1, 'active', 'x', 'x', $2, now())`, [
      countId,
      JSON.stringify([
        { batchId: lost, bookQty: 10, countedQty: 8, difference: -2 },
        { batchId: same, bookQty: 5, countedQty: 5, difference: 0 },
      ]),
    ]);
    const rows = (await (await get(`/admin/reports/stock-variance?itemId=${item}&from=${day(-1)}&to=${day(0)}`)).json()) as {
      count: { id: string };
      batch: { id: string };
      bookQty: number;
      countedQty: number;
      difference: number;
      differencePaise: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: { id: countId }, batch: { id: lost }, bookQty: 10, countedQty: 8, difference: -2, differencePaise: -500 });
    expect((await (await get(`/admin/reports/stock-variance?itemId=${randomUUID()}`)).json()) as unknown[]).toEqual([]);
  });

  it('403 for a doctor; 422 when from is after to', async () => {
    expect((await get('/admin/reports/stock-variance', doctor)).status).toBe(403);
    expect((await get('/admin/reports/stock-variance?from=2026-02-01&to=2026-01-01')).status).toBe(422);
  });
});
