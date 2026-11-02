import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { indiaDate } from '../src/time/india.js';
import { financialYear } from '../src/modules/pharmacy/bills.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const medical = asStaff('dev-medical', ['medical']);
const reception = asStaff('dev-reception', ['staff']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const irfan = seedId('9a710000', 3);
const rahul = seedId('9a710000', 5);
const med = seedId('de000000', 1);
const doctorId = seedId('a0000000', 3);
const paracetamol = { drugId: seedId('d0000000', 1), drugText: 'Paracetamol 500 mg', dose: '1 tab', frequency: 'TDS', days: 3, quantity: 9 };

const prescribe = async (encounterId: string) =>
  ((await (await app.request(`/staff/encounters/${encounterId}/prescriptions`, json({ lines: [paracetamol] }), doctor)).json()) as { id: string }).id;
const opdEncounter = ((await (await app.request('/staff/encounters', json({ patientId: irfan, type: 'OPD', departmentId: med, doctorId }), doctor)).json()) as { id: string }).id;
const admission = (await (await app.request('/staff/admissions', json({ patientId: rahul, departmentId: med, doctorId, ward: 'General Ward A', bed: '7' }), doctor)).json()) as { encounterId: string };

describe('GET /staff/pharmacy/queue', () => {
  const queue = (query = '', who = medical) => app.request(`/staff/pharmacy/queue${query}`, {}, who);
  type Queued = { id: string; setting: string; status: string; patient: { id: string; name: string } };

  it("lists today's confirmed prescriptions, oldest first, with the patient and setting", async () => {
    const opd = await prescribe(opdEncounter);
    const ipd = await prescribe(admission.encounterId);
    const res = await queue();
    expect(res.status).toBe(200);
    const items = (await res.json()) as Queued[];
    expect(items.map((p) => p.id)).toEqual([opd, ipd]);
    expect(items[0]).toMatchObject({ status: 'confirmed', setting: 'opd', patient: { id: irfan } });
    expect(items[1]).toMatchObject({ setting: 'ipd', patient: { id: rahul } });
    expect(((await (await queue('?setting=ipd')).json()) as Queued[]).map((p) => p.id)).toEqual([ipd]);
    expect(((await (await queue('?setting=opd')).json()) as Queued[]).map((p) => p.id)).toEqual([opd]);
    expect(((await (await queue(`?date=${indiaDate(new Date(Date.now() - 86_400_000))}`)).json()) as Queued[])).toEqual([]);
  });

  it('leaves out voided and dispensed prescriptions', async () => {
    const voided = await prescribe(opdEncounter);
    await app.request(`/staff/prescriptions/${voided}/void`, json({ reason: 'wrong drug' }), doctor);
    const dispensed = await prescribe(opdEncounter);
    await db.query("UPDATE prescriptions SET status = 'dispensed' WHERE id = $1", [dispensed]);
    const ids = ((await (await queue()).json()) as Queued[]).map((p) => p.id);
    expect(ids).not.toContain(voided);
    expect(ids).not.toContain(dispensed);
  });

  it('422 for a bad setting or date; 403 for reception', async () => {
    expect((await queue('?setting=er')).status).toBe(422);
    expect((await queue('?date=2026-13-01')).status).toBe(422);
    expect((await queue('', reception)).status).toBe(403);
  });
});

describe('POST /staff/dispenses', () => {
  const admin = asStaff('dev-admin', ['admin']);
  const give = (body: unknown, who = medical) => app.request('/staff/dispenses', json(body), who);
  const drug = (n: number) => seedId('d0000000', n);
  const batch = (n: number) => seedId('ba000000', n);
  const amoxicillin = { drugId: drug(3), drugText: 'Amoxicillin 500 mg', dose: '1 cap', frequency: 'TDS', days: 5, quantity: 15 };
  const onHand = async (n: number) => Number((await db.query('SELECT qty_on_hand FROM batches WHERE id = $1', [batch(n)])).rows[0]?.qty_on_hand);
  const status = async (id: string) => (await db.query('SELECT status FROM prescriptions WHERE id = $1', [id])).rows[0]?.status;
  const rx = async (lines: unknown[]) =>
    ((await (await app.request(`/staff/encounters/${opdEncounter}/prescriptions`, json({ lines }), doctor)).json()) as { id: string }).id;

  it('gives from the chosen batches; the prescription is dispensed once every line is fully given', async () => {
    const id = await rx([paracetamol, amoxicillin]);
    const before = await onHand(2);
    const res = await give({ prescriptionId: id, lines: [{ lineIndex: 0, drugId: drug(1), batchId: batch(2), qty: 9 }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      prescriptionId: id, patientId: irfan, pharmacistId: seedId('a0000000', 8), at: expect.any(String),
      lines: [{ lineIndex: 0, drugId: drug(1), batchId: batch(2), qty: 9 }],
    });
    expect(await onHand(2)).toBe(before - 9);
    expect(await status(id)).toBe('confirmed');
    await give({ prescriptionId: id, lines: [{ lineIndex: 1, drugId: drug(3), batchId: batch(4), qty: 10 }] });
    expect(await status(id)).toBe('confirmed');
    expect((await give({ prescriptionId: id, lines: [{ lineIndex: 1, drugId: drug(3), batchId: batch(4), qty: 5 }] })).status).toBe(201);
    expect(await status(id)).toBe('dispensed');
    expect(await (await give({ prescriptionId: id, lines: [{ lineIndex: 0, drugId: drug(1), batchId: batch(2), qty: 1 }] })).json()).toMatchObject({ error: 'not_confirmed' });
  });

  it('409 for an expired or recalled batch, short stock, or more than prescribed', async () => {
    const id = await rx([{ ...paracetamol, quantity: undefined }, amoxicillin]);
    const line = (more: Record<string, unknown>) => ({ prescriptionId: id, lines: [{ lineIndex: 0, drugId: drug(1), batchId: batch(2), qty: 1, ...more }] });
    expect(await (await give(line({ batchId: batch(1) }))).json()).toMatchObject({ error: 'expired' });
    expect(await (await give(line({ lineIndex: 1, drugId: drug(3), batchId: batch(5) }))).json()).toMatchObject({ error: 'recalled' });
    expect(await (await give(line({ qty: 5000 }))).json()).toMatchObject({ error: 'short_stock' });
    expect(await (await give(line({ lineIndex: 1, drugId: drug(3), batchId: batch(4), qty: 16 }))).json()).toMatchObject({ error: 'over_prescribed' });
    const both = { prescriptionId: id, lines: [{ lineIndex: 0, drugId: drug(1), batchId: batch(3), qty: 499 }, { lineIndex: 0, drugId: drug(1), batchId: batch(3), qty: 2 }] };
    expect(await (await give(both)).json()).toMatchObject({ error: 'short_stock' });
  });

  it('422 for a line that does not fit, or an H1 or NDPS drug without the register details', async () => {
    const id = await rx([paracetamol, { drugText: 'Cefixime 200', dose: '1 tab', frequency: 'BD', days: 5 }, { drugText: 'Morphine inj', dose: '5 mg', frequency: 'SOS', days: 1 }]);
    const line = (more: Record<string, unknown>) => ({ prescriptionId: id, lines: [{ lineIndex: 0, drugId: drug(1), batchId: batch(2), qty: 1, ...more }] });
    expect((await give(line({ lineIndex: 5 }))).status).toBe(422);
    expect((await give(line({ drugId: drug(2) }))).status).toBe(422);
    expect((await give(line({ batchId: batch(4) }))).status).toBe(422);
    expect((await give(line({ lineIndex: 1, drugId: drug(8) }))).status).toBe(422);
    expect((await give(line({ lineIndex: 2, drugId: drug(12) }))).status).toBe(422);
    expect((await give({ prescriptionId: id, lines: [] })).status).toBe(422);
  });

  it('403 without a pharmacist reg. no. or the permission; 404 for no prescription', async () => {
    const id = await rx([paracetamol]);
    const body = { prescriptionId: id, lines: [{ lineIndex: 0, drugId: drug(1), batchId: batch(2), qty: 1 }] };
    expect(await (await give(body, admin)).json()).toMatchObject({ error: 'not_pharmacist' });
    expect((await give(body, reception)).status).toBe(403);
    expect((await give({ ...body, prescriptionId: seedId('d5000000', 999) })).status).toBe(404);
  });
});

describe('GET /staff/dispenses/{id}', () => {
  const read = (id: string, who = medical) => app.request(`/staff/dispenses/${id}`, {}, who);

  it('returns the dispense; 403 for a nurse; 404 for none', async () => {
    const rx = ((await (await app.request(`/staff/encounters/${opdEncounter}/prescriptions`, json({ lines: [paracetamol] }), doctor)).json()) as { id: string }).id;
    const given = (await (await app.request('/staff/dispenses', json({ prescriptionId: rx, lines: [{ lineIndex: 0, drugId: paracetamol.drugId, batchId: seedId('ba000000', 3), qty: 9 }] }), medical)).json()) as { id: string };
    const res = await read(given.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: given.id, prescriptionId: rx, patientId: irfan, lines: [{ qty: 9 }] });
    expect((await read(given.id, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await read(seedId('d5000000', 999))).status).toBe(404);
    expect((await read('nope')).status).toBe(404);
  });
});

describe('POST /staff/dispenses/{id}/return', () => {
  const back = (id: string, body: unknown, who = medical) => app.request(`/staff/dispenses/${id}/return`, json(body), who);
  const onHand = async (n: number) => Number((await db.query('SELECT qty_on_hand FROM batches WHERE id = $1', [seedId('ba000000', n)])).rows[0]?.qty_on_hand);
  const given = async () => {
    const rx = ((await (await app.request(`/staff/encounters/${opdEncounter}/prescriptions`, json({ lines: [paracetamol] }), doctor)).json()) as { id: string }).id;
    const lines = [{ lineIndex: 0, drugId: paracetamol.drugId, batchId: seedId('ba000000', 3), qty: 5 }, { lineIndex: 0, drugId: paracetamol.drugId, batchId: seedId('ba000000', 2), qty: 4 }];
    return { rx, id: ((await (await app.request('/staff/dispenses', json({ prescriptionId: rx, lines }), medical)).json()) as { id: string }).id };
  };

  it('puts the stock back and refunds at the rate on the bill; the prescription stays dispensed', async () => {
    const { rx, id } = await given();
    const bill = (await (await app.request('/staff/pharmacy/bills', json({ patientId: irfan, dispenseId: id, setting: 'ipd' }), medical)).json()) as { id: string };
    // The batch MRP changes after the sale: the refund is still at what the patient paid.
    await db.query('UPDATE batches SET mrp_paise = 9900 WHERE id = $1', [seedId('ba000000', 3)]);
    const [three, two] = [await onHand(3), await onHand(2)];
    const res = await back(id, { lines: [{ lineIndex: 0, qty: 2 }, { lineIndex: 1, qty: 4 }], reason: 'stopped by the doctor', refundMode: 'upi' });
    await db.query('UPDATE batches SET mrp_paise = 2100 WHERE id = $1', [seedId('ba000000', 3)]);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ refundPaise: 2 * 2100 + 4 * 2000, dispense: { id, version: 2, lines: [{ qty: 5, returnedQty: 2 }, { qty: 4, returnedQty: 4 }] } });
    expect([await onHand(3), await onHand(2)]).toEqual([three + 2, two + 4]);
    expect((await db.query('SELECT refund_paise, refund_mode, reason, bill_id FROM pharmacy_returns WHERE dispense_id = $1', [id])).rows).toEqual([
      { refund_paise: 12_200, refund_mode: 'upi', reason: 'stopped by the doctor', bill_id: bill.id },
    ]);
    expect((await db.query('SELECT status FROM prescriptions WHERE id = $1', [rx])).rows[0]?.status).toBe('dispensed');
  });

  it('refunds nothing before the dispense is billed: nothing was charged, and the bill leaves the return out', async () => {
    const { id } = await given();
    expect(await (await back(id, { lines: [{ lineIndex: 0, qty: 1 }], reason: 'one strip extra' })).json()).toMatchObject({ refundPaise: 0 });
    const bill = (await (await app.request('/staff/pharmacy/bills', json({ patientId: irfan, dispenseId: id, setting: 'ipd' }), medical)).json()) as { lines: { qty: number }[] };
    expect(bill.lines.map((l) => l.qty)).toEqual([4, 4]);
  });

  it('409 for more than is left to return; 422 for a missing line or reason; 403 for a nurse; 404 for none', async () => {
    const { id } = await given();
    expect((await back(id, { lines: [{ lineIndex: 0, qty: 3 }], reason: 'not needed' })).status).toBe(201);
    expect(await (await back(id, { lines: [{ lineIndex: 0, qty: 3 }], reason: 'not needed' })).json()).toMatchObject({ error: 'more_than_given' });
    expect((await back(id, { lines: [{ lineIndex: 2, qty: 1 }], reason: 'not needed' })).status).toBe(422);
    expect((await back(id, { lines: [{ lineIndex: 0, qty: 1 }] })).status).toBe(422);
    expect((await back(id, { lines: [{ lineIndex: 0, qty: 1 }], reason: 'not needed' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await back(seedId('d5000000', 999), { lines: [{ lineIndex: 0, qty: 1 }], reason: 'not needed' })).status).toBe(404);
  });
});

describe('POST /staff/pharmacy/bills', () => {
  const bill = (body: unknown, who = medical) => app.request('/staff/pharmacy/bills', json(body), who);
  const batch = (n: number) => seedId('ba000000', n);
  const onHand = async (n: number) => Number((await db.query('SELECT qty_on_hand FROM batches WHERE id = $1', [batch(n)])).rows[0]?.qty_on_hand);
  const dispensed = async () => {
    const rx = ((await (await app.request(`/staff/encounters/${opdEncounter}/prescriptions`, json({ lines: [paracetamol] }), doctor)).json()) as { id: string }).id;
    const lines = [{ lineIndex: 0, drugId: paracetamol.drugId, batchId: batch(3), qty: 6 }, { lineIndex: 0, drugId: paracetamol.drugId, batchId: batch(2), qty: 3 }];
    return ((await (await app.request('/staff/dispenses', json({ prescriptionId: rx, lines }), medical)).json()) as { id: string }).id;
  };
  type Bill = { number?: string; totalPaise: number; gstPaise: number; lines: { qty: number; amountPaise: number }[] };

  it('bills a dispense at the batch MRP (GST inside), less returns; OPD gets the next invoice number', async () => {
    const dispenseId = await dispensed();
    await app.request(`/staff/dispenses/${dispenseId}/return`, json({ lines: [{ lineIndex: 0, qty: 1 }], reason: 'one strip extra' }), medical);
    const res = await bill({ patientId: irfan, dispenseId, setting: 'opd' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Bill;
    const year = financialYear(indiaDate());
    expect(body).toMatchObject({
      patientId: irfan, dispenseId, setting: 'opd', paidPaise: 0, number: `INV/PH/${year}/1`,
      lines: [
        { drugId: paracetamol.drugId, batchId: batch(3), qty: 5, mrpPaise: 2100, gstRate: 5, amountPaise: 10_500 },
        { batchId: batch(2), qty: 3, mrpPaise: 2000, amountPaise: 6000 },
      ],
      totalPaise: 16_500,
      gstPaise: 500 + 286,
    });
    expect(await (await bill({ patientId: irfan, dispenseId, setting: 'opd' })).json()).toMatchObject({ error: 'already_billed' });
    const next = (await (await bill({ patientId: irfan, dispenseId: await dispensed(), setting: 'opd' })).json()) as Bill;
    expect(next.number).toBe(`INV/PH/${year}/2`);
    const ipd = (await (await bill({ patientId: irfan, dispenseId: await dispensed(), setting: 'ipd' })).json()) as Bill;
    expect(ipd.number).toBeUndefined();
  });

  it('sells OTC medicines over the counter, taking the stock; prescription drugs need a dispense', async () => {
    const before = await onHand(3);
    const res = await bill({ patientId: rahul, setting: 'opd', lines: [{ drugId: paracetamol.drugId, batchId: batch(3), qty: 2 }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ totalPaise: 4200, lines: [{ qty: 2 }] });
    expect(await onHand(3)).toBe(before - 2);
    const amox = await bill({ patientId: rahul, setting: 'opd', lines: [{ drugId: seedId('d0000000', 3), batchId: batch(4), qty: 1 }] });
    expect(await amox.json()).toMatchObject({ error: 'prescription_needed' });
    expect(await (await bill({ patientId: rahul, setting: 'opd', lines: [{ drugId: paracetamol.drugId, batchId: batch(1), qty: 1 }] })).json()).toMatchObject({ error: 'expired' });
  });

  it("422 for another patient's dispense, lines with a dispense, or nothing to bill; 403 for a nurse; 404 for no patient", async () => {
    const dispenseId = await dispensed();
    expect((await bill({ patientId: rahul, dispenseId, setting: 'opd' })).status).toBe(422);
    expect((await bill({ patientId: irfan, dispenseId, setting: 'opd', lines: [{ drugId: paracetamol.drugId, batchId: batch(3), qty: 1 }] })).status).toBe(422);
    expect((await bill({ patientId: irfan, setting: 'opd' })).status).toBe(422);
    expect((await bill({ patientId: irfan, dispenseId, setting: 'opd' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await bill({ patientId: seedId('9a710000', 999), dispenseId, setting: 'opd' })).status).toBe(404);
  });
});

describe('financialYear', () => {
  it('runs April to March', () => {
    expect(financialYear('2026-03-31')).toBe('25-26');
    expect(financialYear('2026-04-01')).toBe('26-27');
    expect(financialYear('2099-12-31')).toBe('99-00');
  });
});

describe('GET /staff/pharmacy/bills', () => {
  const list = (query = '', who = medical) => app.request(`/staff/pharmacy/bills${query}`, {}, who);
  type Bills = { items: { id: string; patientId: string; createdAt: string }[]; nextCursor?: string };

  it('lists bills newest first, by patient and IST day, paged', async () => {
    const sale = (patientId: string) =>
      app.request('/staff/pharmacy/bills', json({ patientId, setting: 'opd', lines: [{ drugId: paracetamol.drugId, batchId: seedId('ba000000', 3), qty: 1 }] }), medical);
    const first = ((await (await sale(rahul)).json()) as { id: string }).id;
    const second = ((await (await sale(rahul)).json()) as { id: string }).id;
    const mine = (await (await list(`?patientId=${rahul}`)).json()) as Bills;
    expect(mine.items.slice(0, 2).map((b) => b.id)).toEqual([second, first]);
    expect(mine.items.every((b) => b.patientId === rahul)).toBe(true);
    const today = (await (await list(`?date=${indiaDate()}&limit=1`)).json()) as Bills;
    expect(today.items.map((b) => b.id)).toEqual([second]);
    const page2 = (await (await list(`?date=${indiaDate()}&limit=1&cursor=${today.nextCursor}`)).json()) as Bills;
    expect(page2.items.map((b) => b.id)).toEqual([first]);
    expect(((await (await list('?date=2020-01-01')).json()) as Bills).items).toEqual([]);
  });

  it('422 for a bad date; 403 for a nurse', async () => {
    expect((await list('?date=yesterday')).status).toBe(422);
    expect((await list('', asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('GET /staff/pharmacy/bills/{id}', () => {
  it('returns the bill; 403 for a nurse; 404 for none', async () => {
    const sale = await app.request('/staff/pharmacy/bills', json({ patientId: rahul, setting: 'ipd', lines: [{ drugId: paracetamol.drugId, batchId: seedId('ba000000', 3), qty: 4 }] }), medical);
    const { id } = (await sale.json()) as { id: string };
    const res = await app.request(`/staff/pharmacy/bills/${id}`, {}, medical);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, patientId: rahul, setting: 'ipd', totalPaise: 8400, lines: [{ qty: 4 }] });
    expect((await app.request(`/staff/pharmacy/bills/${id}`, {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    expect((await app.request(`/staff/pharmacy/bills/${seedId('d5000000', 999)}`, {}, medical)).status).toBe(404);
    expect((await app.request('/staff/pharmacy/bills/nope', {}, medical)).status).toBe(404);
  });
});
