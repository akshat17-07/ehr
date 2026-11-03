import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);
const doctor = asStaff('dev-doctor', ['doctor']);
const send = (method: string, path: string, body?: unknown, who = admin) =>
  app.request(path, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }, who);

const newItem = async (name: string, packSize = 10) => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO items (id, status, created_by, updated_by, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise, active)
     VALUES ($1, 'active', 'x', 'x', $2, 'consumable', 'box', $3, '3005', 12, 5000, true)`,
    [id, name, packSize],
  );
  return id;
};
const stockOf = (itemId: string, qty: number, expiry = '2099-01-01', batchNo = 'B1') =>
  db.query(
    `INSERT INTO batches (id, status, created_by, updated_by, item_id, batch_no, expiry, cost_paise, mrp_paise, qty_on_hand) VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $2, $3, 100, 200, $4)`,
    [itemId, batchNo, expiry, qty],
  );
const settings = (itemId: string, body: Record<string, unknown>) => send('PUT', `/admin/inventory/items/${itemId}/reorder-settings`, body);

const supplier = randomUUID();
await db.query(`INSERT INTO suppliers (id, status, created_by, updated_by, name) VALUES ($1, 'active', 'x', 'x', 'Sup One')`, [supplier]);
const low = await newItem('Rc Low');
const fine = await newItem('Rc Fine');
const bare = await newItem('Rc Bare');
const used = await newItem('Rc Used');
const gone = await newItem('Rc Gone');
const soon = await newItem('Rc Soon');
await stockOf(low, 15);
await stockOf(fine, 80);
await stockOf(used, 10);
await stockOf(soon, 50, '2000-01-01'); // expired long ago: never usable
await settings(low, { reorderLevel: 20, minLevel: 5, reorderQty: 50, preferredSupplierId: supplier });
await settings(fine, { reorderLevel: 10, maxLevel: 100 });
await settings(gone, { reorderLevel: 5, maxLevel: 30 });
await db.query(
  `INSERT INTO stock_issues (id, status, created_by, updated_by, created_at, updated_at, patient_id, lines, total_paise)
   VALUES (gen_random_uuid(), 'active', 'x', 'x', now() - interval '3 days', now() - interval '3 days', $1, $2, 0)`,
  [randomUUID(), JSON.stringify([{ itemId: used, batchId: randomUUID(), qty: 60 }])],
);
const ids = [low, fine, bare, used, gone, soon];

interface Row {
  item: { id: string; qtyUsable: number };
  usableQty: number;
  avgDailyUse: number;
  daysLeft?: number;
  reorderPoint: number;
  suggestedQty: number;
  status: string;
  preferredSupplierId?: string;
}
interface Check {
  id: string;
  runBy: string;
  runAt: string;
  settings: Record<string, unknown>;
  counts: Record<string, number>;
  rows?: Row[];
}

describe('#287 POST /admin/inventory/reorder-check', () => {
  it('works out status, point, suggested quantity and supplier, and saves a snapshot', async () => {
    const res = await send('POST', '/admin/inventory/reorder-check', { itemIds: ids, onlyNeedingOrder: false });
    expect(res.status).toBe(201);
    const check = (await res.json()) as Check;
    expect(check.settings).toEqual({ usageDays: 30, excludeExpiringWithinDays: 30, itemIds: ids, onlyNeedingOrder: false });
    const by = new Map(check.rows!.map((r) => [r.item.id, r]));
    expect(by.get(low)).toMatchObject({ status: 'below_reorder', usableQty: 15, reorderPoint: 20, suggestedQty: 50, preferredSupplierId: supplier });
    expect(by.get(fine)).toMatchObject({ status: 'ok', suggestedQty: 0, usableQty: 80 });
    // No settings and no use: ok, reorder point 0, nothing suggested.
    expect(by.get(bare)).toMatchObject({ status: 'ok', reorderPoint: 0, suggestedQty: 0 });
    // No settings but use: 60 units / 30 days = 2 a day; point 2 x 14 = 28; suggested 2 x 44 - 10 = 78 -> pack of 10 = 80.
    expect(by.get(used)).toMatchObject({ status: 'below_reorder', avgDailyUse: 2, daysLeft: 5, reorderPoint: 28, suggestedQty: 80 });
    expect(by.get(used)?.preferredSupplierId).toBeUndefined();
    // Settings, no stock: out of stock, up to maxLevel.
    expect(by.get(gone)).toMatchObject({ status: 'out_of_stock', suggestedQty: 30 });
    // An expired batch is not usable, but with no settings and no use the item is ok.
    expect(by.get(soon)).toMatchObject({ status: 'ok', usableQty: 0 });
    expect(check.counts).toEqual({ out_of_stock: 1, below_min: 0, below_reorder: 2, ok: 3 });
    // Shortest days left first.
    expect(check.rows![0]!.item.id).toBe(used);

    const again = (await (await send('GET', `/admin/inventory/reorder-checks/${check.id}`)).json()) as Check;
    expect(again).toEqual(check);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'reorder_check' AND record_id = $1", [check.id]);
    expect(audit.rows.length).toBe(1);
  });

  it('only rows needing an order by default; kind filter; head doctor allowed', async () => {
    const check = (await (await send('POST', '/admin/inventory/reorder-check', { itemIds: ids }, head)).json()) as Check;
    expect(check.rows!.map((r) => r.item.id).sort()).toEqual([low, used, gone].sort());
    expect(check.counts.ok).toBe(3);
    const implants = (await (await send('POST', '/admin/inventory/reorder-check', { kind: 'implant', usageDays: 7, excludeExpiringWithinDays: 0 })).json()) as Check;
    expect(implants.settings).toMatchObject({ kind: 'implant', usageDays: 7, excludeExpiringWithinDays: 0 });
  });

  it('batches expiring soon do not count as usable', async () => {
    const e = await newItem('Rc Expiring');
    await stockOf(e, 40, new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10));
    await settings(e, { reorderLevel: 10, reorderQty: 20 });
    const rows = ((await (await send('POST', '/admin/inventory/reorder-check', { itemIds: [e] })).json()) as Check).rows!;
    expect(rows[0]).toMatchObject({ usableQty: 0, expiringQty: 40, status: 'out_of_stock', suggestedQty: 20 });
    const kept = ((await (await send('POST', '/admin/inventory/reorder-check', { itemIds: [e], excludeExpiringWithinDays: 0, onlyNeedingOrder: false })).json()) as Check).rows!;
    expect(kept[0]).toMatchObject({ usableQty: 40, expiringQty: 0, status: 'ok' });
  });

  it('403 and 422', async () => {
    expect((await send('POST', '/admin/inventory/reorder-check', {}, doctor)).status).toBe(403);
    const bad = [{ usageDays: 6 }, { usageDays: 181 }, { excludeExpiringWithinDays: -1 }, { kind: 'nope' }, { itemIds: ['x'] }, { itemIds: [randomUUID()] }, { onlyNeedingOrder: 'yes' }, { extra: 1 }];
    for (const body of bad) expect((await send('POST', '/admin/inventory/reorder-check', body)).status, JSON.stringify(body)).toBe(422);
  });
});

describe('#288 / #289 reads', () => {
  it('lists newest first without rows, pages, filters by day', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await send('GET', `/admin/inventory/reorder-checks?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      const page = (await res.json()) as { items: Check[]; nextCursor?: string };
      for (const c of page.items) expect(c.rows).toBeUndefined();
      seen.push(...page.items.map((c) => c.runAt));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect([...seen].sort().reverse()).toEqual(seen);
    const today = new Date().toISOString().slice(0, 10);
    const some = (await (await send('GET', `/admin/inventory/reorder-checks?from=${today}&to=${today}`)).json()) as { items: Check[] };
    expect(some.items.length).toBeGreaterThan(0);
    const none = (await (await send('GET', '/admin/inventory/reorder-checks?to=2020-01-01')).json()) as { items: Check[] };
    expect(none.items).toEqual([]);
    expect((await send('GET', '/admin/inventory/reorder-checks', undefined, doctor)).status).toBe(403);
    expect((await send('GET', '/admin/inventory/reorder-checks?from=nope')).status).toBe(422);
  });

  it('detail 404 and 403', async () => {
    expect((await send('GET', `/admin/inventory/reorder-checks/${randomUUID()}`)).status).toBe(404);
    expect((await send('GET', '/admin/inventory/reorder-checks/nope')).status).toBe(404);
    expect((await send('GET', `/admin/inventory/reorder-checks/${randomUUID()}`, undefined, doctor)).status).toBe(403);
  });
});
