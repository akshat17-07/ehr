import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { financialYear } from '../src/modules/pharmacy/bills.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const medical = asStaff('dev-medical', ['medical']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const irfan = seedId('9a710000', 3);
const kavita = seedId('9a710000', 4);
const rahul = seedId('9a710000', 5);
const tariff = (n: number) => seedId('7a000000', n);
const med = seedId('de000000', 1);
const doctorId = seedId('a0000000', 3);

type Bill = { id: string; status: string; series: string; lines: { text: string; qty: number; unitPaise: number; gstRate: number; amountPaise: number; source?: { kind: string; id: string } }[]; subtotalPaise: number; gstPaise: number; discountPaise: number; totalPaise: number; paidPaise: number; duePaise: number };
const bill = (body: unknown, who = doctor) => app.request('/staff/bills', json(body), who);

describe('POST /staff/bills', () => {
  it('a draft from tariff and free lines; services are a bill of supply', async () => {
    const encounter = (await (await app.request('/staff/encounters', json({ patientId: irfan, type: 'OPD', departmentId: med, doctorId }), doctor)).json()) as { id: string };
    const res = await bill({ patientId: irfan, encounterId: encounter.id, lines: [{ tariffId: tariff(1), qty: 1 }, { tariffId: tariff(4), qty: 2 }, { text: 'Dressing', qty: 1, unitPaise: 15000 }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      status: 'draft', patientId: irfan, encounterId: encounter.id, series: 'bill_of_supply',
      lines: [
        { tariffId: tariff(1), text: 'OPD consultation', qty: 1, unitPaise: 30000, discountPaise: 0, gstRate: 0, amountPaise: 30000 },
        { tariffId: tariff(4), text: 'Complete blood count', qty: 2, unitPaise: 35000, amountPaise: 70000 },
        { text: 'Dressing', qty: 1, unitPaise: 15000, gstRate: 0, amountPaise: 15000 },
      ],
      subtotalPaise: 115000, gstPaise: 0, discountPaise: 0, totalPaise: 115000, paidPaise: 0, duePaise: 115000,
    });
  });

  it('takes in unbilled stock issues and IPD pharmacy bills once; goods make it a tax invoice', async () => {
    const issue = await app.request('/staff/stock/issues', json({ patientId: kavita, lines: [{ itemId: seedId('d0000000', 1), batchId: seedId('ba000000', 3), qty: 4 }] }), medical);
    expect(issue.status).toBe(201);
    const pharmacy = await app.request('/staff/pharmacy/bills', json({ patientId: kavita, setting: 'ipd', lines: [{ drugId: seedId('d0000000', 1), batchId: seedId('ba000000', 3), qty: 10 }] }), medical);
    expect(pharmacy.status).toBe(201);
    const opd = await app.request('/staff/pharmacy/bills', json({ patientId: kavita, setting: 'opd', lines: [{ drugId: seedId('d0000000', 1), batchId: seedId('ba000000', 3), qty: 1 }] }), medical);
    expect(opd.status).toBe(201);
    const first = (await (await bill({ patientId: kavita, lines: [{ tariffId: tariff(8), qty: 2 }] })).json()) as Bill;
    expect(first.series).toBe('tax_invoice');
    expect(first.lines.map((l) => [l.text, l.qty, l.unitPaise, l.gstRate, l.source?.kind])).toEqual([
      ['General ward bed (per day)', 2, 150000, 0, undefined],
      ['Paracetamol (batch PCM2503)', 4, 2100, 5, 'stock_issue'],
      ['Paracetamol (batch PCM2503)', 10, 2100, 5, 'pharmacy_bill'],
    ]);
    expect(first.totalPaise).toBe(300000 + 14 * 2100);
    expect(first.gstPaise).toBe(Math.round((4 * 2100 * 5) / 105) + Math.round((10 * 2100 * 5) / 105));
    const second = (await (await bill({ patientId: kavita, lines: [{ text: 'Ambulance', qty: 1, unitPaise: 50000 }] })).json()) as Bill;
    expect(second.lines).toHaveLength(1);
  });

  it('422 for a bad line, a visit of another patient or nothing to bill; 404 for no patient; 403 for a nurse', async () => {
    const admission = (await (await app.request('/staff/admissions', json({ patientId: rahul, departmentId: med, doctorId, ward: 'General Ward A', bed: '3' }), doctor)).json()) as { id: string };
    expect((await bill({ patientId: irfan, admissionId: admission.id, lines: [{ tariffId: tariff(1), qty: 1 }] })).status).toBe(422);
    expect((await bill({ patientId: irfan, lines: [{ tariffId: tariff(1), qty: 1, unitPaise: 100 }] })).status).toBe(422);
    expect((await bill({ patientId: irfan, lines: [{ text: 'Dressing', qty: 1 }] })).status).toBe(422);
    expect((await bill({ patientId: irfan, lines: [{ tariffId: seedId('7a000000', 999), qty: 1 }] })).status).toBe(422);
    expect((await bill({ patientId: irfan, lines: [] })).status).toBe(422);
    expect((await bill({ patientId: seedId('9a710000', 999), lines: [{ tariffId: tariff(1), qty: 1 }] })).status).toBe(404);
    expect((await bill({ patientId: irfan, lines: [{ tariffId: tariff(1), qty: 1 }] }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('GET /staff/bills', () => {
  type Page = { items: Bill[]; nextCursor?: string };
  const list = async (query = '', who = doctor) => (await (await app.request(`/staff/bills${query}`, {}, who)).json()) as Page;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  it('newest first; filters by patient, day, period and status; pages', async () => {
    const made = (await (await bill({ patientId: rahul, lines: [{ tariffId: tariff(5), qty: 1 }] })).json()) as Bill;
    const all = (await list('?limit=100')).items;
    expect(all[0]?.id).toBe(made.id);
    expect((await list(`?patientId=${rahul}`)).items.map((b) => b.id)).toEqual([made.id]);
    expect((await list(`?date=${today}&status=draft&limit=100`)).items).toHaveLength(all.length);
    expect((await list(`?from=${today}&to=${today}&limit=100`)).items).toHaveLength(all.length);
    expect((await list('?date=2020-01-01')).items).toEqual([]);
    expect((await list('?status=final')).items).toEqual([]);
    const first = await list('?limit=1');
    expect((await list(`?limit=1&cursor=${first.nextCursor}`)).items[0]?.id).toBe(all[1]?.id);
  });

  it('422 for date with from, or a bad status; 403 for a nurse', async () => {
    expect((await app.request(`/staff/bills?date=${today}&from=${today}`, {}, doctor)).status).toBe(422);
    expect((await app.request('/staff/bills?status=open', {}, doctor)).status).toBe(422);
    expect((await app.request('/staff/bills', {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('GET /staff/bills/{id}', () => {
  it('one bill, audited as a view; 404 for none; 403 for a nurse', async () => {
    const made = (await (await bill({ patientId: irfan, lines: [{ tariffId: tariff(5), qty: 1 }] })).json()) as Bill;
    const res = await app.request(`/staff/bills/${made.id}`, {}, doctor);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...made, discounts: [], payments: [] });
    const { rows } = await db.query(`SELECT action FROM audit_events WHERE record_id = $1 ORDER BY at`, [made.id]);
    expect(rows.map((r) => r.action)).toContain('view');
    expect((await app.request(`/staff/bills/${seedId('b1000000', 999)}`, {}, doctor)).status).toBe(404);
    expect((await app.request('/staff/bills/nope', {}, doctor)).status).toBe(404);
    expect((await app.request(`/staff/bills/${made.id}`, {}, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });

  it("an inactive patient's bill needs approved access", async () => {
    const sita = seedId('9a710000', 2);
    const made = (await (await bill({ patientId: sita, lines: [{ tariffId: tariff(5), qty: 1 }] }, asStaff('dev-admin', ['admin']))).json()) as Bill;
    expect((await app.request(`/staff/bills/${made.id}`, {}, doctor)).status).toBe(403);
  });
});

describe('PATCH /staff/bills/{id}', () => {
  const patch = (id: string, body: unknown, who = doctor) =>
    app.request(`/staff/bills/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);

  it('replaces the typed lines and totals; taken-in lines stay', async () => {
    const issue = await app.request('/staff/stock/issues', json({ patientId: rahul, lines: [{ itemId: seedId('d0000000', 1), batchId: seedId('ba000000', 3), qty: 2 }] }), medical);
    expect(issue.status).toBe(201);
    const made = (await (await bill({ patientId: rahul, lines: [{ tariffId: tariff(8), qty: 1 }] })).json()) as Bill & { version: number };
    expect(made.lines).toHaveLength(2);
    const res = await patch(made.id, { version: made.version, lines: [{ tariffId: tariff(8), qty: 3 }, { text: 'Oxygen (per hour)', qty: 5, unitPaise: 10000 }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      version: made.version + 1,
      lines: [{ text: 'General ward bed (per day)', qty: 3 }, { text: 'Oxygen (per hour)', qty: 5 }, { qty: 2, source: { kind: 'stock_issue' } }],
      subtotalPaise: 450000 + 50000 + 4200, totalPaise: 450000 + 50000 + 4200,
    });
    expect((await patch(made.id, { version: made.version, lines: [] })).status).toBe(409);
  });

  it('422 for a bad line; 404 for no bill; 403 for a nurse', async () => {
    const made = (await (await bill({ patientId: irfan, lines: [{ tariffId: tariff(5), qty: 1 }] })).json()) as Bill & { version: number };
    expect((await patch(made.id, { version: made.version, lines: [{ text: 'X', qty: 1 }] })).status).toBe(422);
    expect((await patch(made.id, { version: made.version, lines: [] })).status).toBe(422);
    expect((await patch(seedId('b1000000', 999), { version: 1, lines: [] })).status).toBe(404);
    expect((await patch(made.id, { version: made.version, lines: [] }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});

describe('POST /staff/bills/{id}/finalise', () => {
  const finalise = (id: string, version: number, who = doctor) => app.request(`/staff/bills/${id}/finalise`, json({ version }), who);
  const year = financialYear(indiaDate());
  const draft = async (lines: unknown[]) => (await (await bill({ patientId: irfan, lines })).json()) as Bill & { version: number };

  it('numbers each series in turn, with no gaps after a failed try', async () => {
    const a = await draft([{ tariffId: tariff(1), qty: 1 }]);
    const b = await draft([{ tariffId: tariff(1), qty: 1 }]);
    const res = await finalise(a.id, a.version);
    expect(res.status).toBe(200);
    const first = (await res.json()) as Bill & { number: string; finalisedAt: string };
    expect(first).toMatchObject({ status: 'final', series: 'bill_of_supply', finalisedAt: expect.any(String) });
    const n = Number(first.number.split('/').at(-1));
    expect(first.number).toBe(`BOS/${year}/${n}`);
    expect(await (await finalise(b.id, b.version + 5)).json()).toMatchObject({ error: 'conflict' });
    expect(await (await finalise(a.id, a.version + 1)).json()).toMatchObject({ error: 'not_draft' });
    expect(((await (await finalise(b.id, b.version)).json()) as { number: string }).number).toBe(`BOS/${year}/${n + 1}`);
    const taxed = await (await app.request('/staff/pharmacy/bills', json({ patientId: kavita, setting: 'ipd', lines: [{ drugId: seedId('d0000000', 1), batchId: seedId('ba000000', 3), qty: 1 }] }), medical)).json();
    expect(taxed).toMatchObject({ setting: 'ipd' });
    const c = (await (await bill({ patientId: kavita, lines: [] })).json()) as Bill & { version: number };
    expect(c.series).toBe('tax_invoice');
    expect(((await (await finalise(c.id, c.version)).json()) as { number: string }).number).toMatch(new RegExp(`^INV/${year}/\\d+$`));
  });

  it('a final bill can no longer be changed; 403 for a nurse; 404 for no bill', async () => {
    const d = await draft([{ tariffId: tariff(5), qty: 1 }]);
    expect((await finalise(d.id, d.version, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    await finalise(d.id, d.version);
    const patch = await app.request(`/staff/bills/${d.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: d.version + 1, lines: [] }) }, doctor);
    expect(await patch.json()).toMatchObject({ error: 'not_draft' });
    expect((await finalise(seedId('b1000000', 999), 1)).status).toBe(404);
  });
});

describe('POST /staff/bills/{id}/discounts', () => {
  const discount = (id: string, body: unknown, who = doctor) => app.request(`/staff/bills/${id}/discounts`, json(body), who);
  const draft = async (patientId: string, lines: unknown[]) => (await (await bill({ patientId, lines })).json()) as Bill & { version: number };

  it('up to the limit it comes off the total; over it waits, and the bill cannot be finalised', async () => {
    const d = await draft(irfan, [{ tariffId: tariff(7), qty: 2 }]);
    const res = await discount(d.id, { amountPaise: 20000, reason: 'Staff family' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'applied', billId: d.id, amountPaise: 20000, reason: 'Staff family' });
    const big = (await (await discount(d.id, { amountPaise: 150000, reason: 'Hardship' })).json()) as { id: string; status: string };
    expect(big.status).toBe('pending');
    const read = (await (await app.request(`/staff/bills/${d.id}`, {}, doctor)).json()) as Bill & { version: number; discounts: { status: string }[] };
    expect(read).toMatchObject({ subtotalPaise: 240000, discountPaise: 20000, totalPaise: 220000, duePaise: 220000 });
    expect(read.discounts.map((x) => x.status)).toEqual(['applied', 'pending']);
    expect(await (await app.request(`/staff/bills/${d.id}/finalise`, json({ version: read.version }), doctor)).json()).toMatchObject({ error: 'discount_pending' });
    expect((await discount(d.id, { amountPaise: 80000, reason: 'More' })).status).toBe(422);
  });

  it('GST inside goes down with the discount on a tax invoice', async () => {
    await app.request('/staff/pharmacy/bills', json({ patientId: rahul, setting: 'ipd', lines: [{ drugId: seedId('d0000000', 1), batchId: seedId('ba000000', 3), qty: 50 }] }), medical);
    const d = await draft(rahul, []);
    expect(d).toMatchObject({ series: 'tax_invoice', totalPaise: 105000, gstPaise: 5000 });
    await discount(d.id, { amountPaise: 10500, reason: 'Senior citizen' });
    expect(await (await app.request(`/staff/bills/${d.id}`, {}, doctor)).json()).toMatchObject({ totalPaise: 94500, gstPaise: 4500, discountPaise: 10500 });
  });

  it('409 once final; 404 for no bill; 422 without a reason; 403 for a nurse', async () => {
    const d = await draft(irfan, [{ tariffId: tariff(5), qty: 1 }]);
    expect((await discount(d.id, { amountPaise: 100 })).status).toBe(422);
    expect((await discount(d.id, { amountPaise: 100, reason: 'Kind' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
    await app.request(`/staff/bills/${d.id}/finalise`, json({ version: d.version }), doctor);
    expect(await (await discount(d.id, { amountPaise: 100, reason: 'Late' })).json()).toMatchObject({ error: 'not_draft' });
    expect((await discount(seedId('b1000000', 999), { amountPaise: 100, reason: 'None' })).status).toBe(404);
  });
});

describe('POST /staff/bills/{id}/payments', () => {
  const pay = (id: string, body: unknown, who = doctor) => app.request(`/staff/bills/${id}/payments`, json(body), who);
  const finalBill = async (patientId: string, lines: unknown[]) => {
    const d = (await (await bill({ patientId, lines })).json()) as Bill & { version: number };
    return (await (await app.request(`/staff/bills/${d.id}/finalise`, json({ version: d.version }), doctor)).json()) as Bill;
  };

  it('part then full payment moves the status; payments are listed on the bill', async () => {
    const b = await finalBill(irfan, [{ tariffId: tariff(7), qty: 1 }]);
    const res = await pay(b.id, { amountPaise: 50000, mode: 'cash' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      payment: { billId: b.id, amountPaise: 50000, mode: 'cash', receivedBy: 'dev-doctor', at: expect.any(String) },
      bill: { status: 'part_paid', paidPaise: 50000, duePaise: 70000 },
    });
    expect((await pay(b.id, { amountPaise: 70001, mode: 'upi', reference: 'UPI-1' })).status).toBe(422);
    expect(await (await pay(b.id, { amountPaise: 70000, mode: 'upi', reference: 'UPI-778899' })).json()).toMatchObject({ bill: { status: 'paid', duePaise: 0 } });
    const read = (await (await app.request(`/staff/bills/${b.id}`, {}, doctor)).json()) as { payments: { mode: string }[] };
    expect(read.payments.map((p) => p.mode)).toEqual(['cash', 'upi']);
    expect(await (await pay(b.id, { amountPaise: 1, mode: 'cash' })).json()).toMatchObject({ error: 'not_payable' });
  });

  it('refuses ₹2,00,000 cash from one patient in a day (sec 269ST)', async () => {
    const b = await finalBill(kavita, [{ text: 'Surgery package', qty: 1, unitPaise: 30_000_000 }]);
    expect(await (await pay(b.id, { amountPaise: 20_000_000, mode: 'cash' })).json()).toMatchObject({ error: 'cash_limit' });
    expect((await pay(b.id, { amountPaise: 19_999_900, mode: 'cash' })).status).toBe(201);
    expect(await (await pay(b.id, { amountPaise: 100, mode: 'cash' })).json()).toMatchObject({ error: 'cash_limit' });
    const other = await finalBill(kavita, [{ text: 'Room', qty: 1, unitPaise: 100_000 }]);
    expect(await (await pay(other.id, { amountPaise: 100, mode: 'cash' })).json()).toMatchObject({ error: 'cash_limit' });
    expect((await pay(other.id, { amountPaise: 100, mode: 'card', reference: 'CARD-4411' })).status).toBe(201);
  });

  it('409 for a draft; 422 for UPI without a reference or deposit mode; 403 for a nurse', async () => {
    const d = (await (await bill({ patientId: irfan, lines: [{ tariffId: tariff(5), qty: 1 }] })).json()) as Bill;
    expect(await (await pay(d.id, { amountPaise: 100, mode: 'cash' })).json()).toMatchObject({ error: 'not_payable' });
    expect((await pay(d.id, { amountPaise: 100, mode: 'upi' })).status).toBe(422);
    expect((await pay(d.id, { amountPaise: 100, mode: 'deposit' })).status).toBe(422);
    expect((await pay(d.id, { amountPaise: 100, mode: 'cash' }, asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});
