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
