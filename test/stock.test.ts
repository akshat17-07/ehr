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

describe('POST /staff/stock/grn', () => {
  const supplier = seedId('5a000000', 1);
  const receive = (body: unknown, who = medical) =>
    app.request('/staff/stock/grn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const line = (more: Record<string, unknown> = {}) => ({ itemId: seedId('d0000000', 2), batchNo: 'ORS2601', expiry: '2029-08-31', qty: 100, costPaise: 1500, mrpPaise: 2200, ...more });
  const batch = async (itemId: string, batchNo: string) =>
    (await db.query('SELECT id, qty_on_hand, supplier_id, cost_paise FROM batches WHERE item_id = $1 AND batch_no = $2', [itemId, batchNo])).rows[0];
  let invoice = 0;
  const grn = (lines: unknown[], more: Record<string, unknown> = {}) => ({ supplierId: supplier, invoiceNo: `NPD/${++invoice}`, invoiceDate: '2026-10-30', lines, ...more });

  it('a new batch number becomes a batch; free quantity counts as stock', async () => {
    const res = await receive(grn([line({ freeQty: 10 }), line({ itemId: gauze, batchNo: 'GZ02', expiry: '2031-01-31', qty: 20, costPaise: 3000, mrpPaise: 4500 })]));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { lines: { batchId: string }[] };
    expect(body).toMatchObject({ supplierId: supplier, invoiceNo: `NPD/${invoice}`, invoiceDate: '2026-10-30', receivedBy: 'dev-medical', lines: [{ batchNo: 'ORS2601', freeQty: 10 }, { batchNo: 'GZ02' }] });
    expect(await batch(seedId('d0000000', 2), 'ORS2601')).toEqual({ id: body.lines[0]?.batchId, qty_on_hand: 110, supplier_id: supplier, cost_paise: 1500 });
    expect((await batch(gauze, 'GZ02'))?.qty_on_hand).toBe(20);
  });

  it('a batch on file gets the stock added (lines of one batch together); expiry and MRP must match', async () => {
    const before = Number((await batch(seedId('d0000000', 1), 'PCM2503'))?.qty_on_hand);
    const pcm = line({ itemId: seedId('d0000000', 1), batchNo: 'PCM2503', expiry: '2031-01-31', qty: 30, costPaise: 1300, mrpPaise: 2100 });
    expect((await receive(grn([pcm, { ...pcm, qty: 20 }]))).status).toBe(201);
    expect((await batch(seedId('d0000000', 1), 'PCM2503'))?.qty_on_hand).toBe(before + 50);
    expect((await receive(grn([{ ...pcm, expiry: '2031-02-28' }]))).status).toBe(422);
    expect((await receive(grn([line({ batchNo: 'ORS2602' }), line({ batchNo: 'ORS2602', mrpPaise: 2100 })]))).status).toBe(422);
  });

  it('422 for an expired batch, an MRP above the NPPA ceiling or below cost, an unknown item or supplier, or a future invoice', async () => {
    const error = async (body: unknown) => ((await (await receive(body)).json()) as { message: string }).message;
    expect(await error(grn([line({ expiry: '2020-01-31' })]))).toMatch(/expired/);
    expect(await error(grn([line({ itemId: seedId('d0000000', 1), batchNo: 'PCM9', mrpPaise: 2600 })]))).toMatch(/NPPA ceiling of 2500/);
    expect(await error(grn([line({ costPaise: 2300 })]))).toMatch(/above the MRP/);
    expect((await receive(grn([line({ itemId: seedId('d0000000', 999) })]))).status).toBe(422);
    expect((await receive(grn([line()], { supplierId: seedId('5a000000', 999) }))).status).toBe(422);
    expect((await receive(grn([line()], { invoiceDate: '2099-01-01' }))).status).toBe(422);
    expect((await receive(grn([]))).status).toBe(422);
  });

  it('409 for the same supplier invoice twice; 403 for a nurse', async () => {
    const body = grn([line({ batchNo: 'ORS2610' })]);
    expect((await receive(body)).status).toBe(201);
    expect(await (await receive(body)).json()).toMatchObject({ error: 'duplicate_invoice' });
    expect((await receive(grn([line()]), asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('POST /staff/stock/indents', () => {
  const indent = (body: unknown, who = medical) =>
    app.request('/staff/stock/indents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const ramesh = seedId('9a710000', 1);

  it('records the request, for the ward or one patient', async () => {
    const res = await indent({ ward: 'General Ward A', patientId: ramesh, lines: [{ itemId: gauze, qty: 2 }, { itemId: paracetamol, qty: 10 }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'requested', ward: 'General Ward A', patientId: ramesh, lines: [{ itemId: gauze, qty: 2 }, { itemId: paracetamol, qty: 10 }], createdBy: 'dev-medical' });
    expect(await (await indent({ ward: 'ICU', lines: [{ itemId: gauze, qty: 5 }] })).json()).not.toHaveProperty('patientId');
  });

  it('422 for an unknown item, the same item twice, or no lines; 404 for no patient; 403 for a nurse (not by default)', async () => {
    expect((await indent({ ward: 'ICU', lines: [{ itemId: seedId('17e00000', 999), qty: 1 }] })).status).toBe(422);
    expect((await indent({ ward: 'ICU', lines: [{ itemId: gauze, qty: 1 }, { itemId: gauze, qty: 2 }] })).status).toBe(422);
    expect((await indent({ ward: 'ICU', lines: [] })).status).toBe(422);
    expect((await indent({ ward: 'ICU', patientId: seedId('9a710000', 999), lines: [{ itemId: gauze, qty: 1 }] })).status).toBe(404);
    expect((await indent({ ward: 'ICU', lines: [{ itemId: gauze, qty: 1 }] }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('POST /staff/stock/quarantine', () => {
  const post = (body: unknown, who = medical) =>
    app.request('/staff/stock/quarantine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const amx = seedId('ba000000', 4);
  const row = async () => (await db.query('SELECT qty_on_hand, qty_quarantined FROM batches WHERE id = $1', [amx])).rows[0];

  it('sets stock aside: still on hand, no longer usable', async () => {
    const before = await row();
    const res = await post({ batchId: amx, qty: 10, reason: 'damaged', note: 'strips wet in transit' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ batchId: amx, itemId: seedId('d0000000', 3), qty: 10, reason: 'damaged', note: 'strips wet in transit' });
    expect(await row()).toEqual({ qty_on_hand: before?.qty_on_hand, qty_quarantined: Number(before?.qty_quarantined) + 10 });
    const [stockRow] = ((await (await app.request(`/staff/stock?itemId=${seedId('d0000000', 3)}`, {}, medical)).json()) as { items: { batches: { id: string; qtyUsable: number }[] }[] }).items;
    expect(stockRow?.batches.find((b) => b.id === amx)?.qtyUsable).toBe(Number(before?.qty_on_hand) - Number(before?.qty_quarantined) - 10);
  });

  it('409 for more than is left; 422 for a bad reason; 404 for no batch; 403 for a nurse', async () => {
    expect(await (await post({ batchId: amx, qty: 100_000, reason: 'damaged' })).json()).toMatchObject({ error: 'short_stock' });
    expect((await post({ batchId: amx, qty: 1, reason: 'lost' })).status).toBe(422);
    expect((await post({ batchId: seedId('ba000000', 999), qty: 1, reason: 'other' })).status).toBe(404);
    expect((await post({ batchId: amx, qty: 1, reason: 'other' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('GET /staff/stock/alerts', () => {
  type Alert = { kind: string; item: { name: string }; batch: { batchNo: string }; message: string };
  const alerts = async (query = '') => (await (await app.request(`/staff/stock/alerts${query}`, {}, medical)).json()) as Alert[];
  const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

  it('expired and soon-to-expire stock not set aside, and recalled stock not quarantined', async () => {
    await db.query(
      `INSERT INTO batches (id, status, created_by, updated_by, item_id, batch_no, expiry, cost_paise, mrp_paise, qty_on_hand, qty_quarantined)
       VALUES ($1, 'active', 'x', 'x', $2, 'PCMSOON', $3, 1000, 2000, 30, 0), ($4, 'active', 'x', 'x', $2, 'PCMSET', $3, 1000, 2000, 30, 30)`,
      [seedId('ba000000', 90), paracetamol, soon, seedId('ba000000', 91)],
    );
    const all = await alerts();
    expect(all.map((a) => [a.kind, a.batch.batchNo])).toEqual([
      ['expiry', 'PCM2401'],
      ['expiry', 'PCMSOON'],
    ]);
    expect(all[0]?.message).toBe('Paracetamol batch PCM2401 expired on 2025-12-31: quarantine 40');
    expect(all[1]?.message).toMatch(/^Paracetamol batch PCMSOON expires on .*: 30 in stock$/);
    expect((await alerts('?withinDays=5')).map((a) => a.batch.batchNo)).toEqual(['PCM2401']);
    // The seed's recalled batch is fully quarantined: nothing to do. Release some and it shows.
    await db.query('UPDATE batches SET qty_quarantined = 50 WHERE id = $1', [seedId('ba000000', 5)]);
    expect((await alerts('?kind=recall')).map((a) => [a.kind, a.batch.batchNo, a.message])).toEqual([
      ['recall', 'AMX2499', 'Amoxicillin batch AMX2499 is recalled: quarantine 10 still in stock'],
    ]);
  });

  it('422 for a bad kind; 403 for a nurse', async () => {
    expect((await app.request('/staff/stock/alerts?kind=low', {}, medical)).status).toBe(422);
    expect((await app.request('/staff/stock/alerts', {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});
