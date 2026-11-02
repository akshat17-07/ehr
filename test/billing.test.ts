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
