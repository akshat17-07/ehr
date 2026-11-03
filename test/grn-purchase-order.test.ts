import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });
const medical = { event: { requestContext: { authorizer: { jwt: { claims: { sub: 'dev-medical', 'cognito:groups': '[medical]' } } } } } } as never;

const supplier = randomUUID();
await db.query(`INSERT INTO suppliers (id, status, created_by, updated_by, name) VALUES ($1, 'active', 'x', 'x', 'Grn Po Supplies')`, [supplier]);
const mkItem = async (name: string) => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO items (id, status, created_by, updated_by, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise, active)
     VALUES ($1, 'active', 'x', 'x', $2, 'consumable', 'box', 1, '3005', 12, 5000, true)`,
    [id, name],
  );
  return id;
};
const gauze = await mkItem('Po Gauze');
const tape = await mkItem('Po Tape');
const other = await mkItem('Po Other');

const mkPo = async (status: string, lines = [{ itemId: gauze, qty: 10 }, { itemId: tape, qty: 5 }]) => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO purchase_orders (id, status, created_by, updated_by, supplier_id, lines) VALUES ($1, $2, 'x', 'x', $3, $4)`,
    [id, status, supplier, JSON.stringify(lines)],
  );
  return id;
};
const po = async (id: string) => {
  const r = (await db.query('SELECT status, version, received_qty FROM purchase_orders WHERE id = $1', [id])).rows[0]!;
  return { status: r.status as string, version: Number(r.version), received: JSON.parse(String(r.received_qty)) as Record<string, number> };
};
let n = 0;
const receive = (purchaseOrderId: string | undefined, lines: { itemId: string; qty: number }[]) =>
  app.request(
    '/staff/stock/grn',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        supplierId: supplier,
        ...(purchaseOrderId && { purchaseOrderId }),
        invoiceNo: `GPO/${++n}`,
        invoiceDate: '2026-10-30',
        lines: lines.map((l) => ({ ...l, batchNo: `B${n}`, expiry: '2030-01-31', costPaise: 100, mrpPaise: 200 })),
      }),
    },
    medical,
  );
const onHand = async (itemId: string) => Number((await db.query('SELECT COALESCE(SUM(qty_on_hand), 0) AS q FROM batches WHERE item_id = $1', [itemId])).rows[0]!.q);

describe('GRN against a purchase order', () => {
  it('a full receipt marks the order received', async () => {
    const id = await mkPo('placed');
    const res = await receive(id, [{ itemId: gauze, qty: 10 }, { itemId: tape, qty: 5 }]);
    expect(res.status).toBe(201);
    expect(await po(id)).toEqual({ status: 'received', version: 2, received: { [gauze]: 10, [tape]: 5 } });
    const history = await db.query('SELECT 1 FROM purchase_orders_versions WHERE record_id = $1', [id]);
    expect(history.rows.length).toBe(1);
  });

  it('a partial receipt, then the rest', async () => {
    const id = await mkPo('placed');
    expect((await receive(id, [{ itemId: gauze, qty: 4 }])).status).toBe(201);
    expect(await po(id)).toMatchObject({ status: 'part_received', received: { [gauze]: 4 } });
    expect((await receive(id, [{ itemId: gauze, qty: 6 }])).status).toBe(201);
    expect((await po(id)).status).toBe('part_received');
    expect((await receive(id, [{ itemId: tape, qty: 5 }])).status).toBe(201);
    expect(await po(id)).toMatchObject({ status: 'received', version: 4, received: { [gauze]: 10, [tape]: 5 } });
    const again = await receive(id, [{ itemId: tape, qty: 1 }]);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'po_not_placed' });
  });

  it('422 over_receipt naming the item; nothing is saved', async () => {
    const id = await mkPo('placed');
    const before = await onHand(gauze);
    const res = await receive(id, [{ itemId: gauze, qty: 11 }]);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('over_receipt');
    expect(body.message).toContain('Po Gauze');
    expect(await onHand(gauze)).toBe(before);
    expect(await po(id)).toMatchObject({ status: 'placed', version: 1 });
  });

  it('422 item_not_on_po', async () => {
    const id = await mkPo('placed');
    const res = await receive(id, [{ itemId: other, qty: 1 }]);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'item_not_on_po' });
    expect(await onHand(other)).toBe(0);
  });

  it('409 po_not_placed for a draft or cancelled order; 404 for an unknown one', async () => {
    for (const status of ['draft', 'cancelled']) {
      const res = await receive(await mkPo(status), [{ itemId: gauze, qty: 1 }]);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'po_not_placed' });
    }
    expect((await receive(randomUUID(), [{ itemId: gauze, qty: 1 }])).status).toBe(404);
  });

  it('a GRN without an order works as before', async () => {
    const res = await receive(undefined, [{ itemId: gauze, qty: 3 }]);
    expect(res.status).toBe(201);
  });
});
