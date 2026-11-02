import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
const head = asStaff('dev-head', ['head_doctor']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const irfan = seedId('9a710000', 3);

describe('GET /staff/reports/day-close', () => {
  it("the day's money by mode and by person, less refunds", async () => {
    const draft = (await (await app.request('/staff/bills', json({ patientId: irfan, lines: [{ text: 'Package', qty: 1, unitPaise: 100_000 }] }), doctor)).json()) as { id: string; version: number };
    await app.request(`/staff/bills/${draft.id}/finalise`, json({ version: draft.version }), doctor);
    await app.request(`/staff/bills/${draft.id}/payments`, json({ amountPaise: 40_000, mode: 'cash' }), doctor);
    await app.request(`/staff/bills/${draft.id}/payments`, json({ amountPaise: 30_000, mode: 'upi', reference: 'UPI-5' }), doctor);
    const dep = (await (await app.request(`/staff/patients/${irfan}/deposits`, json({ amountPaise: 50_000, mode: 'card', reference: 'CARD-5' }), head)).json()) as { id: string };
    await app.request(`/staff/deposits/${dep.id}/apply`, json({ billId: draft.id, amountPaise: 30_000 }), head);
    await app.request(`/staff/bills/${draft.id}/refunds`, json({ amountPaise: 10_000, mode: 'cash', reason: 'Overcharged' }), doctor);

    const date = indiaDate();
    const res = await app.request(`/staff/reports/day-close?date=${date}`, {}, head);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      date,
      byMode: { cash: 40_000, upi: 30_000, card: 50_000, deposit: 30_000 },
      byUser: [{ userId: 'dev-doctor', totalPaise: 70_000 }, { userId: 'dev-head', totalPaise: 50_000 }],
      refundsPaise: 10_000,
      netPaise: 110_000,
    });
    const mine = (await (await app.request(`/staff/reports/day-close?date=${date}&userId=dev-doctor`, {}, head)).json()) as { netPaise: number; byMode: { card: number } };
    expect(mine).toMatchObject({ netPaise: 60_000, byMode: { card: 0 } });
    expect(await (await app.request('/staff/reports/day-close?date=2020-01-01', {}, head)).json()).toMatchObject({ netPaise: 0, byUser: [] });
  });

  it('422 without a date; 403 for a doctor', async () => {
    expect((await app.request('/staff/reports/day-close', {}, head)).status).toBe(422);
    expect((await app.request(`/staff/reports/day-close?date=${indiaDate()}`, {}, doctor)).status).toBe(403);
  });
});

describe('GET /staff/reports/opd', () => {
  const med = seedId('de000000', 1);
  const neha = seedId('a0000000', 3);
  /** An OPD visit row at an exact time (the API opens visits now). */
  async function visit(patient: number, at: string, departmentId = med, type = 'OPD') {
    await db.query(
      `INSERT INTO encounters (id, status, created_by, updated_by, patient_id, type, department_id, doctor_id, started_at) VALUES ($1, 'open', 'test', 'test', $2, $3, $4, $5, $6)`,
      [randomUUID(), seedId('9a710000', patient), type, departmentId, neha, new Date(at)],
    );
  }
  const admin = asStaff('dev-admin', ['admin']);
  const report = async (q: string, who = admin) => app.request(`/staff/reports/opd?${q}`, {}, who);

  it('counts new and follow-up OPD visits per India day, department and doctor', async () => {
    await visit(5, '2025-03-01T10:00:00+05:30'); // Rahul's first visit: new
    await visit(5, '2025-03-02T23:30:00+05:30'); // follow-up, still 2 March in India
    await visit(4, '2025-03-02T09:00:00+05:30', med, 'ER'); // ER is not OPD, but makes Kavita's next visit a follow-up
    await visit(4, '2025-03-02T11:00:00+05:30');
    const res = await report('from=2025-03-01&to=2025-03-02');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [
        { date: '2025-03-01', departmentId: med, doctorId: neha, newPatients: 1, followUps: 0, total: 1 },
        { date: '2025-03-02', departmentId: med, doctorId: neha, newPatients: 0, followUps: 2, total: 2 },
      ],
    });
    expect(((await (await report(`from=2025-03-01&to=2025-03-02&doctorId=${randomUUID()}`)).json()) as { rows: [] }).rows).toEqual([]);
  });

  it('a doctor sees only their own departments; 422 for a backwards range; 403 for a nurse', async () => {
    const other = seedId('de000000', 2);
    await visit(5, '2025-04-01T10:00:00+05:30', other);
    const doctor = asStaff('dev-doctor', ['doctor']);
    expect(((await (await report('from=2025-04-01&to=2025-04-01', doctor)).json()) as { rows: [] }).rows).toEqual([]);
    expect((await report(`from=2025-04-01&to=2025-04-01&departmentId=${other}`, doctor)).status).toBe(403);
    expect(((await (await report('from=2025-04-01&to=2025-04-01')).json()) as { rows: [] }).rows).toHaveLength(1);
    expect((await report('from=2025-04-02&to=2025-04-01')).status).toBe(422);
    expect((await report('from=2025-04-01&to=2025-04-01', asStaff('dev-nurse', ['nurse']))).status).toBe(403);
  });
});
