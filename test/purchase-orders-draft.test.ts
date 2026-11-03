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
const doctor = asStaff('dev-doctor', ['doctor']);
const send = (method: string, path: string, body?: unknown, who = admin) =>
  app.request(path, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }, who);

const newItem = async (name: string) => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO items (id, status, created_by, updated_by, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise, active)
     VALUES ($1, 'active', 'x', 'x', $2, 'consumable', 'box', 1, '3005', 12, 5000, true)`,
    [id, name],
  );
  return id;
};
const newSupplier = async (name: string) => {
  const id = randomUUID();
  await db.query(`INSERT INTO suppliers (id, status, created_by, updated_by, name) VALUES ($1, 'active', 'x', 'x', $2)`, [id, name]);
  return id;
};

const supA = await newSupplier('Po Sup A');
const supB = await newSupplier('Po Sup B');
const itemA = await newItem('Po Item A');
const itemB = await newItem('Po Item B');
const itemC = await newItem('Po Item C');

interface Po {
  id: string;
  version: number;
  status: string;
  supplierId: string;
  supplierName?: string;
  reorderCheckId?: string;
  lines: { itemId: string; qty: number; ratePaise?: number }[];
  note?: string;
  receivedQty: Record<string, number>;
}
const make = async (body: Record<string, unknown>) => (await (await send('POST', '/admin/purchase-orders', body)).json()) as Po;

describe('POST /admin/purchase-orders', () => {
  it('makes a draft with the given lines and audits it', async () => {
    const res = await send('POST', '/admin/purchase-orders', {
      supplierId: supA,
      lines: [{ itemId: itemA, qty: 10, ratePaise: 250 }, { itemId: itemB, qty: 5 }],
      note: 'urgent',
    });
    expect(res.status).toBe(201);
    const po = (await res.json()) as Po;
    expect(po).toMatchObject({ status: 'draft', version: 1, supplierId: supA, supplierName: 'Po Sup A', note: 'urgent', receivedQty: {} });
    expect(po.lines).toEqual([{ itemId: itemA, qty: 10, ratePaise: 250 }, { itemId: itemB, qty: 5 }]);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'purchase_order' AND record_id = $1", [po.id]);
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('fills the suggested quantities for that supplier from a saved reorder check', async () => {
    const low = await newItem('Po Low');
    const other = await newItem('Po Other');
    await db.query(
      `INSERT INTO batches (id, status, created_by, updated_by, item_id, batch_no, expiry, cost_paise, mrp_paise, qty_on_hand) VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, 'B1', '2099-01-01', 100, 200, 3)`,
      [low],
    );
    expect((await send('PUT', `/admin/inventory/items/${low}/reorder-settings`, { reorderLevel: 20, reorderQty: 40, preferredSupplierId: supA })).status).toBe(200);
    expect((await send('PUT', `/admin/inventory/items/${other}/reorder-settings`, { reorderLevel: 20, reorderQty: 60, preferredSupplierId: supB })).status).toBe(200);
    const check = (await (await send('POST', '/admin/inventory/reorder-check', { itemIds: [low, other], usageDays: 30, excludeExpiringWithinDays: 0 })).json()) as { id: string };

    const po = await make({ supplierId: supA, reorderCheckId: check.id });
    expect(po).toMatchObject({ status: 'draft', reorderCheckId: check.id, lines: [{ itemId: low, qty: 40 }] });
    const forB = await make({ supplierId: supB, reorderCheckId: check.id });
    expect(forB.lines).toEqual([{ itemId: other, qty: 60 }]);
    // Given lines win over the check.
    const own = await make({ supplierId: supA, reorderCheckId: check.id, lines: [{ itemId: itemC, qty: 1 }] });
    expect(own.lines).toEqual([{ itemId: itemC, qty: 1 }]);
  });

  it('422 for an unknown supplier, item or check, a duplicate item, bad qty, or no lines; 403 without purchase.create', async () => {
    const status = async (body: Record<string, unknown>) => (await send('POST', '/admin/purchase-orders', body)).status;
    expect(await status({ supplierId: randomUUID(), lines: [{ itemId: itemA, qty: 1 }] })).toBe(422);
    expect(await status({ supplierId: supA, lines: [{ itemId: randomUUID(), qty: 1 }] })).toBe(422);
    expect(await status({ supplierId: supA, reorderCheckId: randomUUID(), lines: [{ itemId: itemA, qty: 1 }] })).toBe(422);
    expect(await status({ supplierId: supA, lines: [{ itemId: itemA, qty: 1 }, { itemId: itemA, qty: 2 }] })).toBe(422);
    expect(await status({ supplierId: supA, lines: [{ itemId: itemA, qty: 0 }] })).toBe(422);
    expect(await status({ supplierId: supA })).toBe(422);
    expect(await status({ supplierId: supA, lines: [] })).toBe(422);
    expect(await status({ supplierId: 'nope', lines: [{ itemId: itemA, qty: 1 }] })).toBe(422);
    // A check with nothing for this supplier gives no lines.
    const empty = (await (await send('POST', '/admin/inventory/reorder-check', { itemIds: [itemC], usageDays: 30, excludeExpiringWithinDays: 0 })).json()) as { id: string };
    expect(await status({ supplierId: supB, reorderCheckId: empty.id })).toBe(422);
    expect((await send('POST', '/admin/purchase-orders', { supplierId: supA, lines: [{ itemId: itemA, qty: 1 }] }, doctor)).status).toBe(403);
  });
});

describe('GET /admin/purchase-orders', () => {
  it('lists newest first with status, supplier and day filters and pages', async () => {
    const sup = await newSupplier('Po Sup List');
    const ids: string[] = [];
    for (let n = 0; n < 3; n++) ids.push((await make({ supplierId: sup, lines: [{ itemId: itemA, qty: n + 1 }] })).id);
    await db.query("UPDATE purchase_orders SET created_at = '2024-03-01T05:00:00Z' WHERE id = $1", [ids[0]]);
    await db.query("UPDATE purchase_orders SET created_at = '2024-03-02T05:00:00Z', status = 'placed' WHERE id = $1", [ids[1]]);
    await db.query("UPDATE purchase_orders SET created_at = '2024-03-03T05:00:00Z' WHERE id = $1", [ids[2]]);
    const list = async (query: string) => (await (await send('GET', `/admin/purchase-orders?supplierId=${sup}${query}`)).json()) as { items: Po[]; nextCursor?: string };

    expect((await list('')).items.map((p) => p.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect((await list('&status=placed')).items.map((p) => p.id)).toEqual([ids[1]]);
    expect((await list('&from=2024-03-02&to=2024-03-02')).items.map((p) => p.id)).toEqual([ids[1]]);
    expect((await list('&from=2024-03-02')).items.map((p) => p.id)).toEqual([ids[2], ids[1]]);
    const first = await list('&limit=2');
    expect(first.items.map((p) => p.id)).toEqual([ids[2], ids[1]]);
    expect(first.items[0]?.supplierName).toBe('Po Sup List');
    const second = await list(`&limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((p) => p.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeUndefined();
    expect((await send('GET', '/admin/purchase-orders?status=bogus')).status).toBe(422);
    expect((await send('GET', '/admin/purchase-orders', undefined, doctor)).status).toBe(403);
  });
});

describe('GET /admin/purchase-orders/{id}', () => {
  it('returns the order with its lines and supplier name; 404 for unknown; 403 without permission', async () => {
    const po = await make({ supplierId: supB, lines: [{ itemId: itemA, qty: 2 }] });
    const res = await send('GET', `/admin/purchase-orders/${po.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: po.id, supplierName: 'Po Sup B', lines: [{ itemId: itemA, qty: 2 }] });
    expect((await send('GET', `/admin/purchase-orders/${randomUUID()}`)).status).toBe(404);
    expect((await send('GET', '/admin/purchase-orders/nope')).status).toBe(404);
    expect((await send('GET', `/admin/purchase-orders/${po.id}`, undefined, doctor)).status).toBe(403);
  });
});

describe('PATCH /admin/purchase-orders/{id}', () => {
  it('replaces the lines and note of a draft, keeping the old version', async () => {
    const po = await make({ supplierId: supA, lines: [{ itemId: itemA, qty: 2 }], note: 'first' });
    const res = await send('PATCH', `/admin/purchase-orders/${po.id}`, { version: 1, lines: [{ itemId: itemB, qty: 7, ratePaise: 90 }], note: null });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Po;
    expect(saved).toMatchObject({ version: 2, lines: [{ itemId: itemB, qty: 7, ratePaise: 90 }], supplierName: 'Po Sup A' });
    expect(saved.note).toBeUndefined();
    const history = await db.query('SELECT version, data FROM purchase_orders_versions WHERE record_id = $1', [po.id]);
    expect(history.rows).toHaveLength(1);
    expect(JSON.parse(String(history.rows[0]?.data)).lines).toContain(itemA);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'purchase_order' AND record_id = $1 AND action = 'update'", [po.id]);
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('409 stale version; 409 not_draft once placed or cancelled; 422 bad lines or nothing to change; 404; 403', async () => {
    const po = await make({ supplierId: supA, lines: [{ itemId: itemA, qty: 2 }] });
    expect((await send('PATCH', `/admin/purchase-orders/${po.id}`, { version: 1, note: 'x' })).status).toBe(200);
    expect((await send('PATCH', `/admin/purchase-orders/${po.id}`, { version: 1, note: 'y' })).status).toBe(409);
    expect((await send('PATCH', `/admin/purchase-orders/${po.id}`, { version: 2 })).status).toBe(422);
    expect((await send('PATCH', `/admin/purchase-orders/${po.id}`, { version: 2, lines: [] })).status).toBe(422);
    expect((await send('PATCH', `/admin/purchase-orders/${po.id}`, { version: 2, lines: [{ itemId: randomUUID(), qty: 1 }] })).status).toBe(422);
    for (const status of ['placed', 'cancelled']) {
      await db.query('UPDATE purchase_orders SET status = $2 WHERE id = $1', [po.id, status]);
      const res = await send('PATCH', `/admin/purchase-orders/${po.id}`, { version: 2, note: 'z' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'not_draft' });
    }
    expect((await send('PATCH', `/admin/purchase-orders/${randomUUID()}`, { version: 1, note: 'x' })).status).toBe(404);
    expect((await send('PATCH', `/admin/purchase-orders/${po.id}`, { version: 2, note: 'x' }, doctor)).status).toBe(403);
  });
});
