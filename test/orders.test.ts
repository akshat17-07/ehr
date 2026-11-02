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
const nurse = asStaff('dev-nurse', ['nurse']);
const reception = asStaff('dev-reception', ['staff']);
const ramesh = seedId('9a710000', 1);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Ramesh arrives (appointment 1), which opens his encounter.
const arrived = await app.request(`/staff/appointments/${seedId('a9900000', 1)}/check-in`, { method: 'POST' }, reception);
const encounterId = ((await arrived.json()) as { encounter: { id: string } }).encounter.id;

const order = (body: unknown, encounter = encounterId, who = doctor) => app.request(`/staff/encounters/${encounter}/orders`, json(body), who);

describe('POST /staff/encounters/{id}/orders', () => {
  it('orders a lab test in the open encounter', async () => {
    const res = await order({ kind: 'lab', code: 'CBC', name: 'Complete blood count', notes: 'fasting not needed' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      encounterId, patientId: ramesh, kind: 'lab', code: 'CBC', name: 'Complete blood count', status: 'ordered', results: [], createdBy: 'dev-doctor',
    });
    expect((await order({ kind: 'imaging', name: 'X-ray chest PA view' })).status).toBe(201);
    // A second apart: the local database clock is per millisecond, and same-time rows sort by random id.
    await db.query("UPDATE orders SET created_at = created_at - interval '1 second' WHERE name = 'Complete blood count'");
  });

  it('422 for a bad kind or body; 404 for no encounter; 403 for a nurse; 409 once closed', async () => {
    expect((await order({ kind: 'blood', name: 'CBC' })).status).toBe(422);
    expect((await order({ kind: 'lab' })).status).toBe(422);
    expect((await order({ kind: 'lab', name: 'CBC' }, seedId('e0000000', 999))).status).toBe(404);
    expect((await order({ kind: 'lab', name: 'CBC' }, encounterId, nurse)).status).toBe(403);
    const other = await app.request('/staff/encounters', json({ patientId: seedId('9a710000', 3), type: 'OPD', departmentId: seedId('de000000', 1), doctorId: seedId('a0000000', 3) }), doctor);
    const otherId = ((await other.json()) as { id: string }).id;
    expect((await app.request(`/staff/encounters/${otherId}/close`, json({ version: 1 }), doctor)).status).toBe(200);
    expect(await (await order({ kind: 'lab', name: 'CBC' }, otherId)).json()).toMatchObject({ error: 'closed' });
  });
});

describe('GET /staff/orders', () => {
  type Item = { name: string; status: string; patient: { uhid: string } };
  const list = async (query = '', who = doctor) => {
    const res = await app.request(`/staff/orders${query}`, {}, who);
    return { status: res.status, body: (await res.json()) as { items: Item[]; nextCursor?: string } };
  };

  it('lists orders oldest first, with the patient; filters and pages', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.items.map((o) => o.name)).toEqual(['Complete blood count', 'X-ray chest PA view']);
    expect(body.items[0]).toMatchObject({ status: 'ordered', patient: { uhid: 'U24000001' } });
    expect((await list('?kind=imaging')).body.items.map((o) => o.name)).toEqual(['X-ray chest PA view']);
    expect((await list('?status=resulted')).body.items).toEqual([]);
    expect((await list(`?patientId=${ramesh}&date=${indiaDate()}`)).body.items).toHaveLength(2);
    expect((await list(`?patientId=${seedId('9a710000', 3)}`)).body.items).toEqual([]);
    expect((await list('?date=2020-01-01')).body.items).toEqual([]);
    const first = await list('?limit=1');
    expect(first.body.items.map((o) => o.name)).toEqual(['Complete blood count']);
    expect((await list(`?limit=1&cursor=${first.body.nextCursor}`)).body.items.map((o) => o.name)).toEqual(['X-ray chest PA view']);
  });

  it('422 for a bad filter; 403 for reception', async () => {
    expect((await list('?status=done')).status).toBe(422);
    expect((await list('', reception)).status).toBe(403);
  });
});

describe('POST /staff/orders/{id}/results', () => {
  type Order = { id: string; name: string; status: string; version: number; results: { value?: number; unit?: string; text?: string }[] };
  const orders = async () => ((await (await app.request('/staff/orders', {}, doctor)).json()) as { items: Order[] }).items;
  const result = (id: string, body: unknown, who = doctor) => app.request(`/staff/orders/${id}/results`, json(body), who);

  it('records a value; the order becomes resulted and lists its results', async () => {
    const [cbc] = await orders();
    const res = await result(cbc!.id, { value: 11.2, unit: 'g/dL', text: 'Haemoglobin low' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ orderId: cbc!.id, value: 11.2, unit: 'g/dL', text: 'Haemoglobin low', createdBy: 'dev-doctor' });
    expect((await result(cbc!.id, { text: 'Corrected: Hb 11.4 g/dL' })).status).toBe(201);
    const [after] = await orders();
    expect(after).toMatchObject({ status: 'resulted', version: 2 });
    expect(after!.results.map((r) => r.text)).toEqual(['Haemoglobin low', 'Corrected: Hb 11.4 g/dL']);
  });

  it('422 with neither value nor text, a unit alone, or a future time; 404 for none; 403 for a nurse', async () => {
    const [, xray] = await orders();
    expect((await result(xray!.id, {})).status).toBe(422);
    expect((await result(xray!.id, { unit: 'mm' })).status).toBe(422);
    expect((await result(xray!.id, { text: 'Normal', resultedAt: '2999-01-01T00:00:00Z' })).status).toBe(422);
    expect((await result(seedId('0d000000', 999), { text: 'Normal' })).status).toBe(404);
    expect((await result(xray!.id, { text: 'Normal' }, nurse)).status).toBe(403);
    expect((await orders())[1]).toMatchObject({ status: 'ordered', results: [] });
  });
});

describe('POST /staff/orders/{id}/cancel', () => {
  type Order = { id: string; status: string };
  const orders = async (query = '') => ((await (await app.request(`/staff/orders${query}`, {}, doctor)).json()) as { items: Order[] }).items;
  const cancel = (id: string, body: unknown, who = doctor) => app.request(`/staff/orders/${id}/cancel`, json(body), who);

  it('cancels with a reason; it stays listed as cancelled; no results after', async () => {
    const [, xray] = await orders();
    expect((await cancel(xray!.id, { reason: 'no' })).status).toBe(422);
    expect((await cancel(xray!.id, { reason: 'machine down' }, nurse)).status).toBe(403);
    const res = await cancel(xray!.id, { reason: 'machine down, sent to district hospital' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled', voidReason: 'machine down, sent to district hospital', voidedBy: 'dev-doctor', version: 2 });
    expect((await orders('?status=cancelled')).map((o) => o.id)).toEqual([xray!.id]);
    expect(await (await cancel(xray!.id, { reason: 'once more please' })).json()).toMatchObject({ error: 'cancelled' });
    const late = await app.request(`/staff/orders/${xray!.id}/results`, json({ text: 'Normal' }), doctor);
    expect(await late.json()).toMatchObject({ error: 'cancelled' });
  });

  it('409 once resulted; 404 for none', async () => {
    const [cbc] = await orders();
    expect(await (await cancel(cbc!.id, { reason: 'not needed now' })).json()).toMatchObject({ error: 'resulted' });
    expect((await cancel(seedId('0d000000', 999), { reason: 'not needed now' })).status).toBe(404);
  });
});
