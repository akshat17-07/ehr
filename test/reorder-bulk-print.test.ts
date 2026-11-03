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

const newItem = async (name: string, kind = 'consumable') => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO items (id, status, created_by, updated_by, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise, active)
     VALUES ($1, 'active', 'x', 'x', $2, $3, 'box', 1, '3005', 12, 5000, true)`,
    [id, name, kind],
  );
  return id;
};
const supplier = randomUUID();
await db.query(`INSERT INTO suppliers (id, status, created_by, updated_by, name) VALUES ($1, 'active', 'x', 'x', $2)`, [supplier, 'Sup <b>One</b>']);

const a = await newItem('Bk <script>alert(1)</script>');
const b = await newItem('Bk Two', 'surgical');
const c = await newItem('Bk Three');

describe('#357 PUT /admin/inventory/reorder-settings', () => {
  it('sets many, merges with existing, audits once with the count', async () => {
    const before = (await db.query("SELECT 1 FROM audit_events WHERE record_type = 'reorder_settings'")).rows.length;
    const res = await send('PUT', '/admin/inventory/reorder-settings', {
      items: [
        { itemId: a, reorderLevel: 20, minLevel: 5, reorderQty: 40, preferredSupplierId: supplier },
        { itemId: b, reorderLevel: 3, maxLevel: 10 },
      ],
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>[];
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ itemId: a, version: 1, reorderLevel: 20, leadTimeDays: 7, preferredSupplierId: supplier });
    expect(out[1]).toMatchObject({ itemId: b, maxLevel: 10 });
    const audit = await db.query("SELECT changes FROM audit_events WHERE record_type = 'reorder_settings'");
    expect(audit.rows.length).toBe(before + 1);
    expect(JSON.parse(String(audit.rows.at(-1)?.changes))).toMatchObject({ count: [null, 2], changed: [null, 2] });

    // Again with the same values changes nothing; another field merges.
    const again = (await (await send('PUT', '/admin/inventory/reorder-settings', { items: [{ itemId: a, reorderLevel: 20 }, { itemId: b, safetyDays: 2 }] })).json()) as Record<string, unknown>[];
    expect(again[0]).toMatchObject({ version: 1 });
    expect(again[1]).toMatchObject({ version: 2, safetyDays: 2, maxLevel: 10 });
  });

  it('is all or nothing and names the failing index', async () => {
    const res = await send('PUT', '/admin/inventory/reorder-settings', { items: [{ itemId: c, reorderLevel: 9 }, { itemId: randomUUID(), reorderLevel: 1 }] });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('items[1]');
    expect((await db.query('SELECT 1 FROM reorder_settings WHERE item_id = $1', [c])).rows).toHaveLength(0);

    const levels = await send('PUT', '/admin/inventory/reorder-settings', { items: [{ itemId: c, reorderLevel: 9 }, { itemId: b, minLevel: 50 }] });
    expect(levels.status).toBe(422);
    expect(JSON.stringify(await levels.json())).toContain('items[1]');
    expect((await db.query('SELECT 1 FROM reorder_settings WHERE item_id = $1', [c])).rows).toHaveLength(0);
  });

  it('422 for supplier, empty, duplicate, too many, bad fields; 403', async () => {
    const put = (body: unknown, who = admin) => send('PUT', '/admin/inventory/reorder-settings', body, who);
    expect((await put({ items: [{ itemId: c, preferredSupplierId: randomUUID() }] })).status).toBe(422);
    expect((await put({ items: [{ itemId: c }] })).status).toBe(422);
    expect((await put({ items: [] })).status).toBe(422);
    expect((await put({ items: [{ itemId: c, reorderLevel: 1 }, { itemId: c, reorderLevel: 2 }] })).status).toBe(422);
    expect((await put({ items: Array.from({ length: 501 }, () => ({ itemId: randomUUID(), reorderLevel: 1 })) })).status).toBe(422);
    expect((await put({ items: [{ itemId: 'x', reorderLevel: 1 }] })).status).toBe(422);
    expect((await put({ items: [{ itemId: c, reorderLevel: -1 }] })).status).toBe(422);
    expect((await put({ items: [{ itemId: c, reorderLevel: 1 }] }, doctor)).status).toBe(403);
  });

  it('500 items in one call', async () => {
    const ids = await Promise.all(Array.from({ length: 500 }, (_, i) => newItem(`Bulk ${i}`)));
    const res = await send('PUT', '/admin/inventory/reorder-settings', { items: ids.map((itemId) => ({ itemId, reorderLevel: 4 })) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(500);
  });
});

describe('#356 GET /admin/inventory/reorder-checks/{id}/print', () => {
  it('prints the items to order grouped by supplier or kind, escaped', async () => {
    const check = (await (await send('POST', '/admin/inventory/reorder-check', { itemIds: [a, b] })).json()) as { id: string };
    const res = await send('GET', `/admin/inventory/reorder-checks/${check.id}/print`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Sup &#60;b&#62;One&#60;/b&#62;');
    expect(html).toContain('No preferred supplier');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Bk &#60;script&#62;alert(1)&#60;/script&#62;');

    const byKind = await (await send('GET', `/admin/inventory/reorder-checks/${check.id}/print?groupBy=kind`)).text();
    expect(byKind).toContain('<h2>Consumables</h2>');
    expect(byKind).toContain('<h2>Surgical</h2>');

    const audit = await db.query("SELECT 1 FROM audit_events WHERE action = 'print' AND record_type = 'reorder_check' AND record_id = $1", [check.id]);
    expect(audit.rows.length).toBe(2);
  });

  it('404, 403, 422', async () => {
    const check = (await (await send('POST', '/admin/inventory/reorder-check', { itemIds: [a] })).json()) as { id: string };
    expect((await send('GET', `/admin/inventory/reorder-checks/${randomUUID()}/print`)).status).toBe(404);
    expect((await send('GET', '/admin/inventory/reorder-checks/nope/print')).status).toBe(404);
    expect((await send('GET', `/admin/inventory/reorder-checks/${check.id}/print`, undefined, doctor)).status).toBe(403);
    expect((await send('GET', `/admin/inventory/reorder-checks/${check.id}/print?groupBy=day`)).status).toBe(422);
  });
});
