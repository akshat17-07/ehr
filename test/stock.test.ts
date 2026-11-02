import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const medical = asStaff('dev-medical', ['medical']);
const paracetamol = seedId('d0000000', 1);
const gauze = seedId('17e00000', 1);
await db.query(
  `INSERT INTO items (id, status, created_by, updated_by, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise)
   VALUES ($1, 'active', 'x', 'x', 'Gauze roll 10 cm', 'consumable', 'roll', 12, '3005', 12, 4500)`,
  [gauze],
);
await db.query(
  `INSERT INTO batches (id, status, created_by, updated_by, item_id, batch_no, expiry, cost_paise, mrp_paise, qty_on_hand)
   VALUES ($1, 'active', 'x', 'x', $2, 'GZ01', '2030-01-31', 3000, 4500, 50)`,
  [seedId('ba000000', 99), gauze],
);

type Row = { item: { id: string; name: string; kind: string }; qtyOnHand: number; qtyUsable: number; batches: { batchNo: string }[] };
type Stock = { items: Row[]; nextCursor?: string };

describe('GET /staff/stock', () => {
  const stock = async (query = '') => (await (await app.request(`/staff/stock${query}`, {}, medical)).json()) as Stock;

  it("an item's totals and the batches holding stock, first to expire first", async () => {
    const [row] = (await stock(`?itemId=${paracetamol}`)).items;
    expect(row).toMatchObject({
      item: { id: paracetamol, name: 'Paracetamol', kind: 'drug', unit: 'tablet', gstRate: 5, active: true, qtyOnHand: 840, qtyUsable: 780 },
      qtyOnHand: 840,
      qtyUsable: 780,
    });
    expect(row?.batches.map((b) => b.batchNo)).toEqual(['PCM2401', 'PCM2502', 'PCM2503']);
  });

  it('drugs and other items in one list by name; filtered by kind and name, paged', async () => {
    const all = await stock('?limit=100');
    const names = all.items.map((r) => r.item.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : 1)));
    expect(names).toContain('Gauze roll 10 cm');
    expect((await stock('?kind=consumable')).items).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ id: gauze, unit: 'roll', packSize: 12 }), qtyOnHand: 50, qtyUsable: 50 }),
    ]);
    expect((await stock('?q=AMOX')).items.map((r) => r.item.name)).toEqual(['Amoxicillin']);
    expect((await stock('?q=50%25')).items).toEqual([]);
    const first = await stock('?limit=2');
    const second = await stock(`?limit=2&cursor=${first.nextCursor}`);
    expect([...first.items, ...second.items].map((r) => r.item.name)).toEqual(names.slice(0, 4));
    expect((await stock('?q=ondansetron')).items[0]).toMatchObject({ qtyOnHand: 0, qtyUsable: 0, batches: [] });
  });

  it('422 for a bad kind; 403 for reception', async () => {
    expect((await app.request('/staff/stock?kind=food', {}, medical)).status).toBe(422);
    expect((await app.request('/staff/stock', {}, asStaff('dev-reception', ['staff']))).status).toBe(403);
  });
});
