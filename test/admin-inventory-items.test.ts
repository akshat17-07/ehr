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
const get = (path: string, who = admin) => send('GET', path, undefined, who);

const newItem = async (name: string, kind: string, at: string, active = true) => {
  const id = randomUUID();
  await db.query(
    `INSERT INTO items (id, status, created_by, updated_by, created_at, updated_at, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise, active)
     VALUES ($1, 'active', 'x', 'x', $2, $2, $3, $4, 'box', 10, '3005', 12, 5000, $5)`,
    [id, at, name, kind, active],
  );
  return id;
};
const drugId = randomUUID();
await db.query(
  `INSERT INTO drugs (id, status, created_by, updated_by, name, form, schedule, gst_rate, mrp_paise) VALUES ($1, 'active', 'x', 'x', 'Zzdrug Tabs', 'tablet', 'H', 5, 1000)`,
  [drugId],
);
const gauze = await newItem('Zzgauze Roll', 'consumable', '2025-01-01T00:00:00Z');
const stent = await newItem('Zzstent', 'implant', '2025-01-01T00:00:00Z', false);
const supplier = randomUUID();
await db.query(`INSERT INTO suppliers (id, status, created_by, updated_by, name) VALUES ($1, 'active', 'x', 'x', 'Sup One')`, [supplier]);
await db.query(
  `INSERT INTO batches (id, status, created_by, updated_by, item_id, batch_no, expiry, cost_paise, mrp_paise, qty_on_hand) VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, 'B1', '2099-01-01', 100, 200, 25)`,
  [gauze],
);

interface Item { id: string; version: number; name: string; unit: string; active: boolean; qtyOnHand: number; reorder?: Record<string, unknown> }
const list = async (q: string) => (await (await get(`/admin/inventory/items?${q}`)).json()) as { items: Item[]; nextCursor?: string };

describe('#352 PUT /admin/inventory/items/{id}/reorder-settings', () => {
  it('creates, merges, is idempotent, checks versions and audits before/after', async () => {
    const url = `/admin/inventory/items/${gauze}/reorder-settings`;
    const first = await send('PUT', url, { reorderLevel: 20, minLevel: 5, reorderQty: 50, preferredSupplierId: supplier });
    expect(first.status).toBe(200);
    const s1 = (await first.json()) as Record<string, unknown>;
    expect(s1).toEqual({ itemId: gauze, version: 1, reorderLevel: 20, minLevel: 5, reorderQty: 50, leadTimeDays: 7, safetyDays: 7, preferredSupplierId: supplier });

    const same = (await (await send('PUT', url, { reorderLevel: 20, minLevel: 5 })).json()) as Record<string, unknown>;
    expect(same.version).toBe(1);

    const merged = (await (await send('PUT', url, { version: 1, maxLevel: 100, leadTimeDays: 3 })).json()) as Record<string, unknown>;
    expect(merged).toMatchObject({ version: 2, reorderLevel: 20, maxLevel: 100, leadTimeDays: 3, safetyDays: 7 });
    expect((await send('PUT', url, { version: 1, safetyDays: 1 })).status).toBe(409);

    const audit = await db.query("SELECT changes FROM audit_events WHERE record_type = 'reorder_setting' AND record_id = $1 ORDER BY seq", [gauze]);
    expect(JSON.parse(String(audit.rows[2]?.changes))).toEqual({ maxLevel: [null, 100], leadTimeDays: [7, 3] });
    const hist = await db.query('SELECT 1 FROM reorder_settings_versions');
    expect(hist.rows.length).toBe(1);

    // A drug takes settings too.
    expect((await send('PUT', `/admin/inventory/items/${drugId}/reorder-settings`, { reorderLevel: 0 })).status).toBe(200);
  });

  it('404, 403, 409 on first save with a version, 422', async () => {
    const url = (id: string) => `/admin/inventory/items/${id}/reorder-settings`;
    expect((await send('PUT', url(randomUUID()), { reorderLevel: 1 })).status).toBe(404);
    expect((await send('PUT', url('nope'), { reorderLevel: 1 })).status).toBe(404);
    expect((await send('PUT', url(gauze), { reorderLevel: 1 }, doctor)).status).toBe(403);
    expect((await send('PUT', url(stent), { version: 3, reorderLevel: 1 })).status).toBe(409);
    for (const body of [{}, { reorderLevel: -1 }, { reorderLevel: 1.5 }, { leadTimeDays: 'x' }, { extra: 1 }, { preferredSupplierId: randomUUID() }, { minLevel: 50, reorderLevel: 10 }]) {
      expect((await send('PUT', url(stent), body)).status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('#350 GET /admin/inventory/items', () => {
  it('stock, reorder settings and filters', async () => {
    const all = await list('q=zz&limit=100');
    expect(all.items.map((i) => i.name)).toEqual(['Zzdrug Tabs', 'Zzgauze Roll', 'Zzstent']);
    const g = all.items.find((i) => i.id === gauze);
    expect(g).toMatchObject({ qtyOnHand: 25, reorder: { reorderLevel: 20, maxLevel: 100 } });
    expect(all.items.find((i) => i.id === stent)?.reorder).toBeUndefined();

    expect((await list('q=zz&kind=implant')).items.map((i) => i.id)).toEqual([stent]);
    expect((await list('q=zz&active=false')).items.map((i) => i.id)).toEqual([stent]);
    expect((await list('q=zz&noReorderSettings=true')).items.map((i) => i.id)).toEqual([stent]);
    expect((await list('q=zz&noReorderSettings=false')).items.map((i) => i.id).sort()).toEqual([drugId, gauze].sort());
  });

  it('paging, 403 and 422', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(`q=zz&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items.map((i) => i.name));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['Zzdrug Tabs', 'Zzgauze Roll', 'Zzstent']);
    expect((await get('/admin/inventory/items', doctor)).status).toBe(403);
    for (const q of ['kind=nope', 'active=maybe', 'noReorderSettings=1', 'limit=0']) expect((await get(`/admin/inventory/items?${q}`)).status).toBe(422);
  });
});

describe('#351 PATCH /admin/inventory/items/{id}', () => {
  it('edits an item and a drug, keeps history, audits changes', async () => {
    const res = await send('PATCH', `/admin/inventory/items/${gauze}`, { version: 1, name: 'Zzgauze Roll 10cm', mrpPaise: 5500, active: false, reason: 'price change' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: gauze, version: 2, name: 'Zzgauze Roll 10cm', mrpPaise: 5500, active: false, qtyOnHand: 25, reorder: { reorderLevel: 20 } });
    const hist = await db.query('SELECT reason FROM items_versions WHERE record_id = $1', [gauze]);
    expect(hist.rows[0]?.reason).toBe('price change');
    const audit = await db.query("SELECT changes, reason FROM audit_events WHERE record_type = 'item' AND record_id = $1", [gauze]);
    expect(JSON.parse(String(audit.rows[0]?.changes))).toEqual({ name: ['Zzgauze Roll', 'Zzgauze Roll 10cm'], mrpPaise: [5000, 5500], active: [true, false] });
    expect(audit.rows[0]?.reason).toBe('price change');

    const drug = await send('PATCH', `/admin/inventory/items/${drugId}`, { version: 1, unit: 'strip', gstRate: 12 });
    expect(await drug.json()).toMatchObject({ id: drugId, version: 2, kind: 'drug', unit: 'strip', gstRate: 12 });
  });

  it('403, 404, 409 and 422', async () => {
    const url = `/admin/inventory/items/${stent}`;
    expect((await send('PATCH', url, { version: 1, name: 'Zzstent 2' }, doctor)).status).toBe(403);
    expect((await send('PATCH', `/admin/inventory/items/${randomUUID()}`, { version: 1, name: 'Whatever' })).status).toBe(404);
    expect((await send('PATCH', url, { version: 9, name: 'Zzstent 2' })).status).toBe(409);
    for (const [target, body] of [
      [stent, { version: 1 }],
      [stent, { version: 1, name: 'Zzstent' }],
      [stent, { name: 'No version' }],
      [stent, { version: 1, gstRate: 7 }],
      [stent, { version: 1, hsn: 'abc' }],
      [stent, { version: 1, mrpPaise: -1 }],
      [stent, { version: 1, kind: 'drug' }],
      [drugId, { version: 2, packSize: 10 }],
    ] as const) {
      expect((await send('PATCH', `/admin/inventory/items/${target}`, body)).status, JSON.stringify(body)).toBe(422);
    }
  });
});
