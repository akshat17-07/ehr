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

describe('POST /staff/recalls', () => {
  const recall = (body: unknown, who = medical) =>
    app.request('/staff/recalls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const ors = seedId('d0000000', 2);
  const batch = async (no: string) => (await db.query('SELECT id, qty_on_hand, qty_quarantined, recalled FROM batches WHERE item_id = $1 AND batch_no = $2', [ors, no])).rows[0];

  it('marks the batches recalled and quarantines their free stock; batch numbers not on file change nothing', async () => {
    await db.query(
      `INSERT INTO batches (id, status, created_by, updated_by, item_id, batch_no, expiry, cost_paise, mrp_paise, qty_on_hand, qty_quarantined)
       VALUES ($1, 'active', 'x', 'x', $2, 'ORSR1', '2030-01-31', 1000, 2200, 40, 5), ($3, 'active', 'x', 'x', $2, 'ORSR2', '2030-01-31', 1000, 2200, 0, 0)`,
      [seedId('ba000000', 80), ors, seedId('ba000000', 81)],
    );
    const res = await recall({ itemId: ors, batchNos: ['ORSR1', 'ORSR2', 'ORS-NEVER'], reference: 'CDSCO alert 2026/114' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body).toMatchObject({
      itemId: ors, batchNos: ['ORSR1', 'ORSR2', 'ORS-NEVER'], reference: 'CDSCO alert 2026/114',
      batches: [{ batchId: seedId('ba000000', 80), batchNo: 'ORSR1', qtyQuarantined: 35 }, { batchId: seedId('ba000000', 81), batchNo: 'ORSR2', qtyQuarantined: 0 }],
    });
    expect(await batch('ORSR1')).toMatchObject({ qty_on_hand: 40, qty_quarantined: 40, recalled: true });
    expect(await batch('ORSR2')).toMatchObject({ recalled: true });
    expect((await db.query('SELECT qty, reason, recall_id FROM quarantines WHERE batch_id = $1', [seedId('ba000000', 80)])).rows).toEqual([
      { qty: 35, reason: 'recalled', recall_id: body.id },
    ]);
  });

  it('422 for an unknown item or no batch numbers; 403 for a nurse', async () => {
    expect((await recall({ itemId: seedId('d0000000', 999), batchNos: ['X'], reference: 'ref-1' })).status).toBe(422);
    expect((await recall({ itemId: ors, batchNos: [], reference: 'ref-1' })).status).toBe(422);
    expect((await recall({ itemId: ors, batchNos: ['X'], reference: 'ref-1' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('GET /staff/inventory/items', () => {
  type Items = { items: { id: string; name: string; kind: string; active: boolean; qtyOnHand: number; qtyUsable: number }[]; nextCursor?: string };
  const list = async (query = '', who = medical) => (await (await app.request(`/staff/inventory/items${query}`, {}, who)).json()) as Items;

  it('drugs and other items by name, with stock totals; filters by kind, name and active', async () => {
    const gauzeRow = (await list('?kind=consumable')).items.find((i) => i.id === gauze);
    expect(gauzeRow).toMatchObject({ name: 'Gauze roll 10 cm', kind: 'consumable', unit: 'roll', packSize: 12, active: true, qtyOnHand: expect.any(Number) });
    expect((await list('?kind=consumable')).items.every((i) => i.kind === 'consumable')).toBe(true);
    expect((await list('?q=PARACET')).items.map((i) => [i.id, i.kind])).toEqual([[paracetamol, 'drug']]);
    expect((await list('?active=false')).items.every((i) => !i.active)).toBe(true);
    const all = await list('?limit=100');
    expect(all.items.map((i) => i.name)).toEqual([...all.items.map((i) => i.name)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const first = await list('?limit=2');
    expect(first.items).toHaveLength(2);
    expect((await list(`?limit=2&cursor=${first.nextCursor}`)).items[0]?.id).toBe(all.items[2]?.id);
  });

  it('422 for a bad kind; 403 for reception', async () => {
    expect((await app.request('/staff/inventory/items?kind=food', {}, medical)).status).toBe(422);
    expect((await app.request('/staff/inventory/items', {}, asStaff('dev-reception', ['staff']))).status).toBe(403);
  });
});

describe('POST /staff/inventory/items', () => {
  const add = (body: unknown, who = medical) =>
    app.request('/staff/inventory/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('adds an item with no stock; a similar name needs force', async () => {
    const res = await add({ name: 'Surgical gloves 7.5', kind: 'surgical', unit: 'pair', packSize: 50, hsn: '4015', gstRate: 12, mrpPaise: 3000 });
    expect(res.status).toBe(201);
    const item = (await res.json()) as { id: string };
    expect(item).toMatchObject({ name: 'Surgical gloves 7.5', kind: 'surgical', unit: 'pair', packSize: 50, hsn: '4015', gstRate: 12, mrpPaise: 3000, active: true, qtyOnHand: 0, qtyUsable: 0 });
    const dup = await add({ name: 'surgical  Gloves, 7.5', kind: 'surgical', unit: 'pair' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: 'possible_duplicate', matches: [{ id: item.id, name: 'Surgical gloves 7.5' }] });
    expect(await (await add({ name: 'Gauze roll', kind: 'consumable', unit: 'roll' })).json()).toMatchObject({ error: 'possible_duplicate', matches: [{ id: gauze }] });
    expect(await (await add({ name: 'Paracetamol syrup', kind: 'other', unit: 'bottle' })).json()).toMatchObject({ error: 'possible_duplicate' });
    expect((await add({ name: 'surgical  Gloves, 7.5', kind: 'surgical', unit: 'pair', force: true })).status).toBe(201);
    expect((await add({ name: 'Surgical gloves 8', kind: 'surgical', unit: 'pair' })).status).toBe(201);
  });

  it('422 for a drug, a bad GST rate or extra fields; 403 for a nurse', async () => {
    expect((await add({ name: 'Some tablet', kind: 'drug', unit: 'tablet' })).status).toBe(422);
    expect((await add({ name: 'Cotton', kind: 'consumable', unit: 'roll', gstRate: 7 })).status).toBe(422);
    expect((await add({ name: 'Cotton', kind: 'consumable', unit: 'roll', qtyOnHand: 5 })).status).toBe(422);
    expect((await add({ name: 'Cotton', kind: 'consumable', unit: 'roll' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('POST /staff/stock/indents/{id}/issue', () => {
  const post = (url: string, body: unknown, who = medical) =>
    app.request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const ramesh = seedId('9a710000', 1);
  const gz = seedId('ba000000', 99);
  const indentFor = async (lines: unknown[], patientId: string | undefined = ramesh) =>
    ((await (await post('/staff/stock/indents', { ward: 'General Ward A', ...(patientId && { patientId }), lines })).json()) as { id: string }).id;
  const onHand = async () => Number((await db.query('SELECT qty_on_hand FROM batches WHERE id = $1', [gz])).rows[0]?.qty_on_hand);

  it('issues from the chosen batches, priced at MRP; the indent is issued', async () => {
    const id = await indentFor([{ itemId: gauze, qty: 3 }]);
    const before = await onHand();
    const res = await post(`/staff/stock/indents/${id}/issue`, { patientId: ramesh, lines: [{ itemId: gauze, batchId: gz, qty: 2 }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      indent: { id, status: 'issued' },
      issue: { patientId: ramesh, indentId: id, totalPaise: 9000, lines: [{ itemId: gauze, batchId: gz, qty: 2, mrpPaise: 4500, gstRate: 12, amountPaise: 9000 }] },
    });
    expect(await onHand()).toBe(before - 2);
    expect(await (await post(`/staff/stock/indents/${id}/issue`, { patientId: ramesh, lines: [{ itemId: gauze, batchId: gz, qty: 1 }] })).json()).toMatchObject({ error: 'not_requested' });
  });

  it('422 for another patient, an item not asked for, or more than asked; 409 short stock; 404; 403 for a nurse', async () => {
    const id = await indentFor([{ itemId: gauze, qty: 3 }]);
    const issue = (body: Record<string, unknown>, who = medical) => post(`/staff/stock/indents/${id}/issue`, { patientId: ramesh, lines: [{ itemId: gauze, batchId: gz, qty: 1 }], ...body }, who);
    expect((await issue({ patientId: seedId('9a710000', 3) })).status).toBe(422);
    expect((await issue({ lines: [{ itemId: paracetamol, batchId: seedId('ba000000', 3), qty: 1 }] })).status).toBe(422);
    expect((await issue({ lines: [{ itemId: gauze, batchId: gz, qty: 2 }, { itemId: gauze, batchId: gz, qty: 2 }] })).status).toBe(422);
    expect((await issue({ lines: [{ itemId: gauze, batchId: seedId('ba000000', 3), qty: 1 }] })).status).toBe(422);
    const wardIndent = await indentFor([{ itemId: gauze, qty: 5000 }], undefined);
    expect(await (await post(`/staff/stock/indents/${wardIndent}/issue`, { patientId: ramesh, lines: [{ itemId: gauze, batchId: gz, qty: 5000 }] })).json()).toMatchObject({ error: 'short_stock' });
    expect((await post(`/staff/stock/indents/${seedId('17e00000', 999)}/issue`, { patientId: ramesh, lines: [{ itemId: gauze, batchId: gz, qty: 1 }] })).status).toBe(404);
    expect((await issue({}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('POST /staff/stock/issues', () => {
  const issue = (body: Record<string, unknown>, who = medical) =>
    app.request('/staff/stock/issues', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const ramesh = seedId('9a710000', 1);
  const gz = seedId('ba000000', 99);
  const line = { itemId: gauze, batchId: gz, qty: 1 };
  const doctor = asStaff('dev-doctor', ['doctor']);
  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('takes the items for the patient, linked to the visit, priced at MRP', async () => {
    const encounter = (await (await app.request('/staff/encounters', json({ patientId: ramesh, type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) }), doctor)).json()) as { id: string };
    const res = await issue({ patientId: ramesh, encounterId: encounter.id, lines: [{ ...line, qty: 3 }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ patientId: ramesh, encounterId: encounter.id, totalPaise: 13500, lines: [{ itemId: gauze, qty: 3, amountPaise: 13500 }] });
    expect(await (await issue({ patientId: seedId('9a710000', 3), encounterId: encounter.id, lines: [line] })).json()).toMatchObject({ error: 'validation_failed' });
  });

  it('409 for short stock; 422 for an unknown link; 404 for no patient; 403 for reception', async () => {
    expect(await (await issue({ patientId: ramesh, lines: [{ ...line, qty: 9_999 }] })).json()).toMatchObject({ error: 'short_stock' });
    expect((await issue({ patientId: ramesh, surgeryId: seedId('17e00000', 999), lines: [line] })).status).toBe(422);
    expect((await issue({ patientId: seedId('9a710000', 999), lines: [line] })).status).toBe(404);
    expect((await issue({ patientId: ramesh, lines: [line] }, asStaff('dev-reception', ['staff']))).status).toBe(403);
  });
});

describe('POST /staff/stock/counts', () => {
  const count = (body: unknown, who = medical) =>
    app.request('/staff/stock/counts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const gz = seedId('ba000000', 99);
  const pcm = seedId('ba000000', 3);
  const onHand = async (id: string) => Number((await db.query('SELECT qty_on_hand FROM batches WHERE id = $1', [id])).rows[0]?.qty_on_hand);

  it('records book and counted quantities with the difference; stock is not changed', async () => {
    const [gzBook, pcmBook] = [await onHand(gz), await onHand(pcm)];
    const res = await count({ lines: [{ batchId: gz, countedQty: gzBook - 2 }, { batchId: pcm, countedQty: pcmBook }], note: 'Monthly count, store 1' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      countedBy: 'dev-medical', at: expect.any(String), note: 'Monthly count, store 1',
      lines: [{ batchId: gz, bookQty: gzBook, countedQty: gzBook - 2, difference: -2 }, { batchId: pcm, bookQty: pcmBook, countedQty: pcmBook, difference: 0 }],
    });
    expect([await onHand(gz), await onHand(pcm)]).toEqual([gzBook, pcmBook]);
  });

  it('422 for an unknown batch, a batch twice or a negative count; 403 for reception', async () => {
    expect((await count({ lines: [{ batchId: seedId('ba000000', 999), countedQty: 1 }] })).status).toBe(422);
    expect((await count({ lines: [{ batchId: gz, countedQty: 1 }, { batchId: gz, countedQty: 2 }] })).status).toBe(422);
    expect((await count({ lines: [{ batchId: gz, countedQty: -1 }] })).status).toBe(422);
    expect((await count({ lines: [{ batchId: gz, countedQty: 1 }] }, asStaff('dev-reception', ['staff']))).status).toBe(403);
  });
});

describe('POST /staff/stock/supplier-returns', () => {
  const send = (body: Record<string, unknown>, who = medical) =>
    app.request('/staff/stock/supplier-returns', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
  const supplier = seedId('5a000000', 1);
  const batch = async (id: string) => (await db.query('SELECT qty_on_hand, qty_quarantined, cost_paise FROM batches WHERE id = $1', [id])).rows[0];

  it('stock leaves the books, quarantined stock first; lines are costed', async () => {
    const id = seedId('ba000000', 60);
    await db.query(
      `INSERT INTO batches (id, status, created_by, updated_by, item_id, batch_no, expiry, cost_paise, mrp_paise, qty_on_hand, qty_quarantined)
       VALUES ($1, 'active', 'x', 'x', $2, 'RET01', '2030-01-31', 1200, 2000, 30, 10)`,
      [id, paracetamol],
    );
    const res = await send({ supplierId: supplier, lines: [{ batchId: id, qty: 12 }], reason: 'damaged', creditNoteNo: 'CN-881', refundPaise: 14400, refundMode: 'credit_note' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ supplierId: supplier, lines: [{ batchId: id, qty: 12, amountPaise: 14400 }], reason: 'damaged', creditNoteNo: 'CN-881', refundPaise: 14400, refundMode: 'credit_note' });
    expect(await batch(id)).toMatchObject({ qty_on_hand: 18, qty_quarantined: 0 });
    expect(await (await send({ supplierId: supplier, lines: [{ batchId: id, qty: 19 }], reason: 'excess', refundPaise: 0 })).json()).toMatchObject({ error: 'short_stock' });
  });

  it('422 for an unknown supplier or batch, a batch twice or a bad reason; 403 for a nurse', async () => {
    const gz = seedId('ba000000', 99);
    const body = { supplierId: supplier, lines: [{ batchId: gz, qty: 1 }], reason: 'expired', refundPaise: 0 };
    expect((await send({ ...body, supplierId: seedId('5a000000', 999) })).status).toBe(422);
    expect((await send({ ...body, lines: [{ batchId: seedId('ba000000', 999), qty: 1 }] })).status).toBe(422);
    expect((await send({ ...body, lines: [{ batchId: gz, qty: 1 }, { batchId: gz, qty: 1 }] })).status).toBe(422);
    expect((await send({ ...body, reason: 'unwanted' })).status).toBe(422);
    expect((await send(body, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('GET /staff/stock/movements', () => {
  type Moves = { items: { at: string; itemId: string; batchId: string; kind: string; qty: number; ref: string; by: string }[]; nextCursor?: string };
  const moves = async (query = '', who = medical) => (await (await app.request(`/staff/stock/movements${query}`, {}, who)).json()) as Moves;
  const gz = seedId('ba000000', 99);

  it('every change to a batch, newest first, signed in and out', async () => {
    const ret = await moves(`?batchId=${seedId('ba000000', 60)}`);
    expect(ret.items).toEqual([{ at: expect.any(String), itemId: paracetamol, batchId: seedId('ba000000', 60), kind: 'supplier_return', qty: -12, ref: expect.any(String), by: 'dev-medical' }]);
    const gauzeMoves = (await moves(`?itemId=${gauze}&limit=100`)).items;
    expect(gauzeMoves.length).toBeGreaterThan(0);
    expect(gauzeMoves.every((m) => m.itemId === gauze && (m.kind === 'issue' ? m.qty < 0 : m.kind === 'grn' && m.qty > 0))).toBe(true);
    expect(gauzeMoves.filter((m) => m.batchId === gz).map((m) => [m.kind, m.qty])).toEqual([['issue', -3], ['issue', -2]]);
    expect(gauzeMoves.map((m) => m.at)).toEqual([...gauzeMoves.map((m) => m.at)].sort().reverse());
    expect((await moves('?kind=grn&limit=100')).items.every((m) => m.kind === 'grn' && m.qty > 0)).toBe(true);
    const quarantined = (await moves(`?kind=quarantine&batchId=${seedId('ba000000', 4)}`)).items;
    expect(quarantined[0]).toMatchObject({ kind: 'quarantine', qty: -10, itemId: seedId('d0000000', 3) });
  });

  it('pages without repeats; an old period is empty', async () => {
    const all = (await moves('?limit=100')).items;
    const first = await moves('?limit=3');
    const second = await moves(`?limit=3&cursor=${first.nextCursor}`);
    expect([...first.items, ...second.items]).toEqual(all.slice(0, 6));
    expect((await moves('?from=2020-01-01&to=2020-01-31')).items).toEqual([]);
  });

  it('422 for a backwards or too long period or a bad kind; 403 for reception', async () => {
    expect((await app.request('/staff/stock/movements?from=2026-02-01&to=2026-01-01', {}, medical)).status).toBe(422);
    expect((await app.request('/staff/stock/movements?from=2024-01-01&to=2026-01-01', {}, medical)).status).toBe(422);
    expect((await app.request('/staff/stock/movements?kind=theft', {}, medical)).status).toBe(422);
    expect((await app.request('/staff/stock/movements', {}, asStaff('dev-reception', ['staff']))).status).toBe(403);
  });
});

describe('GET /staff/purchase-orders', () => {
  type Po = { id: string; status: string; number?: string; supplierId: string; lines: unknown[]; placedAt?: string; receivedQty: Record<string, number> };
  const list = async (query = '', who = medical) => (await (await app.request(`/staff/purchase-orders${query}`, {}, who)).json()) as Po[];
  const [s1, s2] = [seedId('5a000000', 1), seedId('5a000000', 2)];
  const po = (n: number) => seedId('90000000', n);

  it('open orders only, oldest placed first; filters by status and supplier', async () => {
    const insert = (n: number, status: string, supplier: string, placedAt: string | null, received = '{}') =>
      db.query(
        `INSERT INTO purchase_orders (id, status, created_by, updated_by, number, supplier_id, lines, placed_at, received_qty)
         VALUES ($1, $2, 'x', 'x', $3, $4, $5, $6, $7)`,
        [po(n), status, `PO-${n}`, supplier, JSON.stringify([{ itemId: gauze, qty: 100, ratePaise: 3000 }]), placedAt, received],
      );
    await insert(1, 'draft', s1, null);
    await insert(2, 'placed', s1, '2026-10-20T05:00:00Z');
    await insert(3, 'part_received', s2, '2026-10-10T05:00:00Z', JSON.stringify({ [gauze]: 40 }));
    await insert(4, 'received', s1, '2026-10-01T05:00:00Z');
    await insert(5, 'cancelled', s2, '2026-10-02T05:00:00Z');
    expect((await list()).map((p) => p.id)).toEqual([po(3), po(2)]);
    expect((await list())[0]).toMatchObject({ number: 'PO-3', supplierId: s2, status: 'part_received', placedAt: '2026-10-10T05:00:00.000Z', receivedQty: { [gauze]: 40 }, lines: [{ itemId: gauze, qty: 100, ratePaise: 3000 }] });
    expect((await list('?status=placed')).map((p) => p.id)).toEqual([po(2)]);
    expect((await list(`?supplierId=${s2}`)).map((p) => p.id)).toEqual([po(3)]);
  });

  it('422 for a closed status; 403 for reception', async () => {
    expect((await app.request('/staff/purchase-orders?status=draft', {}, medical)).status).toBe(422);
    expect((await app.request('/staff/purchase-orders', {}, asStaff('dev-reception', ['staff']))).status).toBe(403);
  });
});
