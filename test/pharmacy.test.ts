import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { indiaDate } from '../src/time/india.js';

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
