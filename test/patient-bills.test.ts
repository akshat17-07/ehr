import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// #247 /patient/bills, #248 /patient/bills/{id}, #249 /patient/bills/{id}/print.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asPatient = (sub: string) => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, email: `${sub}@x.in` } } } } } }) as never;
const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const A = asPatient('pt-bills-ramesh');
const B = asPatient('pt-bills-kavita');
const doctor = asStaff('dev-doctor', ['doctor']);
const medical = asStaff('dev-medical', ['medical']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ramesh = seedId('9a710000', 1);
const sita = seedId('9a710000', 2); // A's wife, with portal access through A
const kavita = seedId('9a710000', 4);
const tariff = (n: number) => seedId('7a000000', n);
const AT = '2026-10-01T04:00:00Z';

const get = (path: string, who: never) => app.request(path, {}, who);
const generic403 = { error: 'forbidden', message: 'not a patient this account may see' };

type Line = { category: string; text: string; qty: number; unitPaise: number; amountPaise: number };
type PortalBill = Record<string, unknown> & { id: string; status: string; lines: Line[]; payments?: Record<string, unknown>[] };
type Page = { items: PortalBill[]; nextCursor?: string };

const MONEY = ['subtotalPaise', 'gstPaise', 'discountPaise', 'totalPaise', 'paidPaise', 'duePaise'] as const;
const STAFF_FIELDS = ['version', 'createdBy', 'updatedBy', 'voidedAt', 'voidedBy', 'voidReason', 'creditNoteNo', 'discounts', 'refunds'];

const staffBill = async (id: string) => (await (await get(`/staff/bills/${id}`, doctor)).json()) as Record<string, unknown> & { version: number };
const draft = async (patientId: string, lines: unknown[]) =>
  (await (await app.request('/staff/bills', json({ patientId, lines }), doctor)).json()) as { id: string; version: number };
const finalise = async (id: string) => {
  const b = await staffBill(id);
  const res = await app.request(`/staff/bills/${id}/finalise`, json({ version: b.version }), doctor);
  expect(res.status).toBe(200);
};
const pay = async (id: string, body: unknown) => expect((await app.request(`/staff/bills/${id}/payments`, json(body), doctor)).status).toBe(201);

// Ramesh: a part-paid bill (with a discount and a deposit payment), a paid one, a draft and a voided one.
let partPaid: string, paid: string, draftBill: string, voided: string, receiptNo: string;
// Sita: a bill with a lab test, a stock issue and an IPD pharmacy bill. Kavita: someone else.
let sitaBill: string, kavitaBill: string;

beforeAll(async () => {
  await db.query(
    `INSERT INTO patient_accounts (id, status, created_at, created_by, updated_by, patient_id, cognito_sub)
     VALUES ($1, 'active', $2, 'system', 'system', $3, 'pt-bills-ramesh'), ($4, 'active', $2, 'system', 'system', $5, 'pt-bills-kavita')`,
    [randomUUID(), AT, ramesh, randomUUID(), kavita],
  );
  await db.query(
    `INSERT INTO guardians (id, status, created_at, created_by, updated_by, patient_id, guardian_patient_id, name, relation, portal_access)
     VALUES ($1, 'active', $2, 'system', 'system', $3, $4, 'Ramesh', 'Husband', true)`,
    [randomUUID(), AT, sita, ramesh],
  );

  // A visit each, so the doctor may open their bills (staff access rule).
  for (const patientId of [ramesh, sita, kavita]) {
    const visit = { patientId, type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) };
    expect((await app.request('/staff/encounters', json(visit), doctor)).status).toBe(201);
  }

  partPaid = (await draft(ramesh, [{ tariffId: tariff(1), qty: 1 }, { tariffId: tariff(4), qty: 2 }, { text: 'Dressing', qty: 1, unitPaise: 15000 }])).id;
  expect((await app.request(`/staff/bills/${partPaid}/discounts`, json({ amountPaise: 5000, reason: 'Staff family' }), doctor)).status).toBe(201);
  await finalise(partPaid);
  await pay(partPaid, { amountPaise: 20000, mode: 'upi', reference: 'UPI777' });
  const dep = (await (await app.request(`/staff/patients/${ramesh}/deposits`, json({ amountPaise: 10000, mode: 'cash' }), doctor)).json()) as {
    id: string;
    receiptNo: string;
  };
  receiptNo = dep.receiptNo;
  expect((await app.request(`/staff/deposits/${dep.id}/apply`, json({ billId: partPaid, amountPaise: 10000 }), doctor)).status).toBe(200);

  paid = (await draft(ramesh, [{ tariffId: tariff(1), qty: 1 }])).id;
  await finalise(paid);
  await pay(paid, { amountPaise: 30000, mode: 'cash' });

  draftBill = (await draft(ramesh, [{ text: 'Not yet billed', qty: 1, unitPaise: 999 }])).id;

  voided = (await draft(ramesh, [{ text: 'Wrong patient', qty: 1, unitPaise: 1234 }])).id;
  await finalise(voided);
  expect((await app.request(`/staff/bills/${voided}/void`, json({ reason: 'Wrong patient' }), doctor)).status).toBe(200);

  expect(
    (await app.request('/staff/stock/issues', json({ patientId: sita, lines: [{ itemId: seedId('d0000000', 1), batchId: seedId('ba000000', 3), qty: 2 }] }), medical)).status,
  ).toBe(201);
  expect(
    (await app.request('/staff/pharmacy/bills', json({ patientId: sita, setting: 'ipd', lines: [{ drugId: seedId('d0000000', 1), batchId: seedId('ba000000', 3), qty: 3 }] }), medical))
      .status,
  ).toBe(201);
  sitaBill = (await draft(sita, [{ tariffId: tariff(4), qty: 1 }])).id;
  await finalise(sitaBill);

  kavitaBill = (await draft(kavita, [{ tariffId: tariff(1), qty: 1 }])).id;
  await finalise(kavitaBill);
});

const withLabel = async (patientId: string, fn: () => Promise<void>) => {
  await db.query("UPDATE patients SET labels = '[\"hiv\"]' WHERE id = $1", [patientId]);
  try {
    await fn();
  } finally {
    await db.query("UPDATE patients SET labels = '[]' WHERE id = $1", [patientId]);
  }
};

describe('GET /patient/bills', () => {
  it('own issued bills, newest first; drafts and voided bills are left out; status filter and paging', async () => {
    const res = await get('/patient/bills', A);
    expect(res.status).toBe(200);
    const page = (await res.json()) as Page;
    expect(page.items.map((b) => b.id)).toEqual([paid, partPaid]);
    expect(page.items.map((b) => b.status)).toEqual(['paid', 'part_paid']);

    expect(((await (await get('/patient/bills?status=part_paid', A)).json()) as Page).items.map((b) => b.id)).toEqual([partPaid]);
    expect((await get('/patient/bills?status=draft', A)).status).toBe(422);
    expect((await get('/patient/bills?status=void', A)).status).toBe(422);

    const first = (await (await get('/patient/bills?limit=1', A)).json()) as Page;
    expect(first.items.map((b) => b.id)).toEqual([paid]);
    const second = (await (await get(`/patient/bills?limit=1&cursor=${first.nextCursor}`, A)).json()) as Page;
    expect(second.items.map((b) => b.id)).toEqual([partPaid]);
  });

  it('amounts are integer paise and equal the staff bill; no staff fields', async () => {
    const page = (await (await get('/patient/bills', A)).json()) as Page;
    for (const b of page.items) {
      const staff = await staffBill(b.id);
      for (const k of MONEY) {
        expect(Number.isInteger(b[k])).toBe(true);
        expect(b[k]).toBe(staff[k]);
      }
      for (const k of STAFF_FIELDS) expect(b).not.toHaveProperty(k);
      for (const l of b.lines) expect(Object.keys(l).sort()).toEqual(['amountPaise', 'category', 'discountPaise', 'gstRate', 'qty', 'text', 'unitPaise']);
    }
    const pp = page.items.find((b) => b.id === partPaid)!;
    expect(pp).toMatchObject({ subtotalPaise: 115000, discountPaise: 5000, totalPaise: 110000, paidPaise: 30000, duePaise: 80000 });
    expect(pp.lines.map((l) => [l.category, l.text])).toEqual([
      ['service', 'OPD consultation'],
      ['service', 'Complete blood count'],
      ['service', 'Dressing'],
    ]);
  });

  it("a family member's bills; another patient's ID is the generic 403", async () => {
    const page = (await (await get(`/patient/bills?patientId=${sita}`, A)).json()) as Page;
    expect(page.items.map((b) => b.id)).toEqual([sitaBill]);
    expect(page.items[0]!.lines.map((l) => l.category)).toEqual(['service', 'supply', 'medicine']);

    for (const other of [kavita, seedId('9a710000', 999), 'not-a-uuid']) {
      const res = await get(`/patient/bills?patientId=${other}`, A);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    expect(((await (await get('/patient/bills', B)).json()) as Page).items.map((b) => b.id)).toEqual([kavitaBill]);
  });

  it('a sensitive label replaces line text with its category; amounts stay', async () => {
    await withLabel(sita, async () => {
      const [b] = ((await (await get(`/patient/bills?patientId=${sita}`, A)).json()) as Page).items;
      expect(b!.lines.map((l) => l.text)).toEqual(['Hospital services', 'Medical supplies', 'Medicines']);
      expect(JSON.stringify(b)).not.toMatch(/blood count|Paracetamol|PCM/i);
    });
    const [b] = ((await (await get(`/patient/bills?patientId=${sita}`, A)).json()) as Page).items;
    const staff = await staffBill(b!.id);
    for (const k of MONEY) expect(b![k]).toBe(staff[k]);
  });
});

describe('GET /patient/bills/{id}', () => {
  it('one bill with its lines and payments (mode, date, amount, receipt), no staff ids; audited', async () => {
    const res = await get(`/patient/bills/${partPaid}`, A);
    expect(res.status).toBe(200);
    const b = (await res.json()) as PortalBill;
    const staff = await staffBill(partPaid);
    for (const k of MONEY) expect(b[k]).toBe(staff[k]);
    for (const k of STAFF_FIELDS) expect(b).not.toHaveProperty(k);
    expect(b).toMatchObject({ id: partPaid, status: 'part_paid', patientId: ramesh, series: 'bill_of_supply', number: expect.any(String) });
    expect(b.payments).toEqual([
      { id: expect.any(String), mode: 'upi', amountPaise: 20000, at: expect.any(String), reference: 'UPI777' },
      { id: expect.any(String), mode: 'deposit', amountPaise: 10000, at: expect.any(String), receiptNo },
    ]);
    expect(JSON.stringify(b)).not.toMatch(/dev-doctor|receivedBy|tariffId|"source"/);

    const { rows } = await db.query(
      "SELECT patient_id::text AS patient_id, action FROM audit_events WHERE record_type = 'bill' AND record_id::text = $1 ORDER BY seq DESC LIMIT 1",
      [partPaid],
    );
    expect(rows[0]).toMatchObject({ patient_id: ramesh, action: 'view' });
  });

  it("a family member's bill opens; foreign, draft, voided, unknown and bad ids are the same generic 403", async () => {
    expect((await get(`/patient/bills/${sitaBill}`, A)).status).toBe(200);
    for (const id of [kavitaBill, draftBill, voided, seedId('b1000000', 999), 'nope']) {
      const res = await get(`/patient/bills/${id}`, A);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
    expect((await get(`/patient/bills/${sitaBill}`, B)).status).toBe(403);
  });

  it('a sensitive label masks the line text', async () => {
    await withLabel(sita, async () => {
      const b = (await (await get(`/patient/bills/${sitaBill}`, A)).json()) as PortalBill;
      expect(b.lines.map((l) => l.text)).toEqual(['Hospital services', 'Medical supplies', 'Medicines']);
      expect(JSON.stringify(b)).not.toMatch(/blood count|Paracetamol|PCM/i);
    });
  });
});

describe('GET /patient/bills/{id}/print', () => {
  it('the staff print in English or Hindi, audited as a print', async () => {
    const res = await get(`/patient/bills/${partPaid}/print`, A);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toBe(await (await get(`/staff/bills/${partPaid}/print`, doctor)).text());
    expect(html).toContain('Bill of Supply');
    expect(html).toContain('₹800.00'); // due
    expect(html).toContain('UPI777');

    const hi = await (await get(`/patient/bills/${partPaid}/print?lang=hi`, A)).text();
    expect(hi).toContain('<html lang="hi">');
    expect(hi).toContain('आपूर्ति का बिल');
    expect(hi).toContain('बकाया');

    const { rows } = await db.query(
      "SELECT patient_id::text AS patient_id, action FROM audit_events WHERE record_type = 'bill' AND record_id::text = $1 ORDER BY seq DESC LIMIT 1",
      [partPaid],
    );
    expect(rows[0]).toMatchObject({ patient_id: ramesh, action: 'print' });
    expect((await get(`/patient/bills/${partPaid}/print?lang=fr`, A)).status).toBe(422);
  });

  it('foreign, draft, voided and unknown bills are the generic 403', async () => {
    for (const id of [kavitaBill, draftBill, voided, seedId('b1000000', 999)]) {
      const res = await get(`/patient/bills/${id}/print`, A);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(generic403);
    }
  });

  it('a sensitive label prints categories, in Hindi too, never the test or drug names', async () => {
    await withLabel(sita, async () => {
      const en = await (await get(`/patient/bills/${sitaBill}/print`, A)).text();
      expect(en).toContain('Hospital services');
      expect(en).toContain('Medicines');
      expect(en).not.toMatch(/blood count|Paracetamol|PCM/i);
      const hi = await (await get(`/patient/bills/${sitaBill}/print?lang=hi`, A)).text();
      expect(hi).toContain('अस्पताल सेवाएँ');
      expect(hi).toContain('दवाइयाँ');
      expect(hi).toContain('चिकित्सा सामग्री');
      expect(hi).not.toMatch(/blood count|Paracetamol|PCM/i);
    });
  });
});
