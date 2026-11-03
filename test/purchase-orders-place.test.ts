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

const itemId = randomUUID();
await db.query(
  `INSERT INTO items (id, status, created_by, updated_by, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise, active)
   VALUES ($1, 'active', 'x', 'x', 'Po <b>Gauze</b>', 'consumable', 'box', 1, '3005', 12, 5000, true)`,
  [itemId],
);
const supplier = randomUUID();
await db.query(`INSERT INTO suppliers (id, status, created_by, updated_by, name, gstin) VALUES ($1, 'active', 'x', 'x', 'Po & Sons', '23ABCDE1234F1Z5')`, [supplier]);

interface Po {
  id: string;
  version: number;
  status: string;
  number?: string;
  placedAt?: string;
}
const draft = async (note = 'deliver <soon>') =>
  (await (await send('POST', '/admin/purchase-orders', { supplierId: supplier, lines: [{ itemId, qty: 4, ratePaise: 1250 }], note })).json()) as Po;
const place = (id: string, version: number, who = admin) => send('POST', `/admin/purchase-orders/${id}/place`, { version }, who);
const cancel = (id: string, body: unknown = { reason: 'ordered by mistake' }, who = admin) => send('POST', `/admin/purchase-orders/${id}/cancel`, body, who);

describe('POST /admin/purchase-orders/{id}/place', () => {
  it('numbers the draft and places it; numbers are unique; audited', async () => {
    const a = await draft();
    const b = await draft();
    const res = await place(a.id, a.version);
    expect(res.status).toBe(200);
    const placed = (await res.json()) as Po;
    expect(placed).toMatchObject({ status: 'placed', version: 2 });
    expect(placed.number).toMatch(/^PO\/\d{2}-\d{2}\/\d+$/);
    expect(placed.placedAt).toBeTruthy();
    const other = (await (await place(b.id, b.version)).json()) as Po;
    expect(other.number).not.toBe(placed.number);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'purchase_order' AND record_id = $1", [a.id]);
    expect(audit.rows.length).toBeGreaterThan(0);
    const open = (await (await send('GET', '/staff/purchase-orders', undefined, admin)).json()) as { id: string }[];
    expect(open.map((p) => p.id)).toContain(a.id);
  });

  it('409 not_draft when already placed; 409 on a stale version; 422 without lines; 404; 403; 422 bad body', async () => {
    const a = await draft();
    expect((await place(a.id, 5)).status).toBe(409);
    expect((await place(a.id, a.version)).status).toBe(200);
    const again = await place(a.id, 2);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'not_draft' });
    const empty = await draft();
    await db.query("UPDATE purchase_orders SET lines = '[]' WHERE id = $1", [empty.id]);
    expect((await place(empty.id, empty.version)).status).toBe(422);
    expect((await place(randomUUID(), 1)).status).toBe(404);
    expect((await send('POST', `/admin/purchase-orders/${empty.id}/place`, {})).status).toBe(422);
    const c = await draft();
    expect((await place(c.id, c.version, doctor)).status).toBe(403);
  });
});

describe('POST /admin/purchase-orders/{id}/cancel', () => {
  it('cancels a draft and a placed order, keeping the reason in the history', async () => {
    const a = await draft();
    const res = await cancel(a.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled', version: 2 });
    const history = await db.query('SELECT reason FROM purchase_orders_versions WHERE record_id = $1', [a.id]);
    expect(history.rows[0]?.reason).toBe('ordered by mistake');
    const audit = await db.query("SELECT reason FROM audit_events WHERE record_type = 'purchase_order' AND record_id = $1 AND reason IS NOT NULL", [a.id]);
    expect(audit.rows.length).toBeGreaterThan(0);

    const b = await draft();
    await place(b.id, b.version);
    expect(await (await cancel(b.id)).json()).toMatchObject({ status: 'cancelled' });
  });

  it('409 already_cancelled; 409 goods_received once anything was received; 422 no reason; 404; 403', async () => {
    const a = await draft();
    await cancel(a.id);
    const twice = await cancel(a.id);
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({ error: 'already_cancelled' });

    const b = await draft();
    await place(b.id, b.version);
    await db.query("UPDATE purchase_orders SET status = 'part_received', received_qty = $2 WHERE id = $1", [b.id, JSON.stringify({ [itemId]: 1 })]);
    const received = await cancel(b.id);
    expect(received.status).toBe(409);
    expect(await received.json()).toMatchObject({ error: 'goods_received' });
    await db.query("UPDATE purchase_orders SET status = 'received' WHERE id = $1", [b.id]);
    expect(await (await cancel(b.id)).json()).toMatchObject({ error: 'goods_received' });

    const c = await draft();
    expect((await cancel(c.id, {})).status).toBe(422);
    expect((await cancel(randomUUID())).status).toBe(404);
    expect((await cancel(c.id, { reason: 'ordered by mistake' }, doctor)).status).toBe(403);
  });
});

describe('GET /admin/purchase-orders/{id}/print', () => {
  it('returns an escaped printable page for a placed order and audits a print', async () => {
    const a = await draft();
    const placed = (await (await place(a.id, a.version)).json()) as Po;
    const res = await send('GET', `/admin/purchase-orders/${a.id}/print`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain(placed.number as string);
    expect(html).toContain('Po &#38; Sons');
    expect(html).toContain('Po &#60;b&#62;Gauze&#60;/b&#62;');
    expect(html).toContain('deliver &#60;soon&#62;');
    expect(html).toContain('₹50.00');
    expect(html).not.toContain('<b>Gauze');
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'purchase_order' AND record_id = $1 AND action = 'print'", [a.id]);
    expect(audit.rows.length).toBe(1);
  });

  it('409 not_placed for a draft or cancelled order; 404; 403', async () => {
    const a = await draft();
    const res = await send('GET', `/admin/purchase-orders/${a.id}/print`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_placed' });
    await cancel(a.id);
    expect((await send('GET', `/admin/purchase-orders/${a.id}/print`)).status).toBe(409);
    expect((await send('GET', `/admin/purchase-orders/${randomUUID()}/print`)).status).toBe(404);
    expect((await send('GET', `/admin/purchase-orders/${a.id}/print`, undefined, doctor)).status).toBe(403);
  });
});
