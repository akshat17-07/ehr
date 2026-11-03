import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
const head = asStaff('dev-head-doctor', ['head_doctor']);
const admin = asStaff('dev-admin', ['admin']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const irfan = seedId('9a710000', 3);

type Bill = { id: string; version: number; status: string; discountPaise: number; totalPaise: number };
const getBill = async (id: string) => (await (await app.request(`/staff/bills/${id}`, {}, doctor)).json()) as Bill;

async function draftBill(unitPaise = 500_000) {
  return (await (await app.request('/staff/bills', json({ patientId: irfan, lines: [{ text: 'Package', qty: 1, unitPaise }] }), doctor)).json()) as Bill;
}
/** A discount over the limit (Rs 1,000), waiting for approval; raised by the doctor. */
async function pendingDiscount(billId: string, amountPaise = 150_000) {
  const res = await app.request(`/staff/bills/${billId}/discounts`, json({ amountPaise, reason: 'Hardship' }), doctor);
  const d = (await res.json()) as { id: string; status: string };
  expect(d.status).toBe('pending');
  return d.id;
}
const decide = async (id: string, verb: 'approve' | 'reject', body: unknown = {}, who = head) => {
  const res = await app.request(`/admin/discounts/${id}/${verb}`, json(body), who);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe('POST /admin/discounts/{id}/approve', () => {
  it('approves: it comes off the bill total, the approver is kept, the bill can then be finalised', async () => {
    const bill = await draftBill();
    const id = await pendingDiscount(bill.id);
    const { status, body } = await decide(id, 'approve', { note: 'hardship confirmed' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id, status: 'applied', approvedBy: 'dev-head-doctor', amountPaise: 150_000, billId: bill.id });
    const read = await getBill(bill.id);
    expect(read).toMatchObject({ discountPaise: 150_000, totalPaise: 350_000 });
    const fin = await app.request(`/staff/bills/${bill.id}/finalise`, json({ version: read.version }), doctor);
    expect(fin.status).toBe(200);
    expect((await decide(id, 'approve')).status).toBe(409);
    expect((await decide(id, 'reject', { reason: 'changed my mind' })).status).toBe(409);
  });

  it('403 on a discount you raised or without approval.discount; 404; 409 if the bill is no longer a draft', async () => {
    const bill = await draftBill();
    const id = await pendingDiscount(bill.id);
    expect((await decide(id, 'approve', {}, doctor)).status).toBe(403);
    await db.query("UPDATE discounts SET created_by = 'dev-head-doctor' WHERE id = $1", [id]);
    expect((await decide(id, 'approve')).status).toBe(403);
    expect((await decide(id, 'reject', { reason: 'not mine to decide' })).status).toBe(403);
    expect((await decide(id, 'approve', {}, admin)).status).toBe(200);
    expect((await decide(randomUUID(), 'approve')).status).toBe(404);
    expect((await decide('nope', 'approve')).status).toBe(404);

    const other = await draftBill();
    const stuck = await pendingDiscount(other.id);
    await db.query("UPDATE bills SET status = 'final' WHERE id = $1", [other.id]);
    expect((await decide(stuck, 'approve')).status).toBe(409);
    expect((await db.query('SELECT status FROM discounts WHERE id = $1', [stuck])).rows[0]).toMatchObject({ status: 'pending' });
  });
});

describe('POST /admin/discounts/{id}/reject', () => {
  it('rejects: the bill total is unchanged, the reason is kept, and the bill can be finalised', async () => {
    const bill = await draftBill();
    const id = await pendingDiscount(bill.id);
    const { status, body } = await decide(id, 'reject', { reason: 'not a valid discount' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id, status: 'rejected' });
    const read = await getBill(bill.id);
    expect(read).toMatchObject({ discountPaise: 0, totalPaise: 500_000 });
    const history = await db.query('SELECT reason FROM discounts_versions WHERE record_id = $1', [id]);
    expect(history.rows[0]).toMatchObject({ reason: 'not a valid discount' });
    expect((await app.request(`/staff/bills/${bill.id}/finalise`, json({ version: read.version }), doctor)).status).toBe(200);
  });

  it('422 for a short or missing reason; 403 without approval.discount; the discount stays pending', async () => {
    const id = await pendingDiscount((await draftBill()).id);
    expect((await decide(id, 'reject', { reason: 'no' })).status).toBe(422);
    expect((await decide(id, 'reject', {})).status).toBe(422);
    expect((await decide(id, 'reject', { reason: 'not a valid discount' }, doctor)).status).toBe(403);
    expect((await db.query('SELECT status FROM discounts WHERE id = $1', [id])).rows[0]).toMatchObject({ status: 'pending' });
  });
});
