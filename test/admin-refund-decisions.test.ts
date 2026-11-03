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
const head = asStaff('dev-head-doctor', ['head_doctor']);
const admin = asStaff('dev-admin', ['admin']);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const irfan = seedId('9a710000', 3);

type Bill = { id: string; version: number; paidPaise: number; status: string };
const getBill = async (id: string) => (await (await app.request(`/staff/bills/${id}`, {}, doctor)).json()) as Bill;

async function paidBill(unitPaise: number) {
  const d = (await (await app.request('/staff/bills', json({ patientId: irfan, lines: [{ text: 'Package', qty: 1, unitPaise }] }), doctor)).json()) as Bill;
  await app.request(`/staff/bills/${d.id}/finalise`, json({ version: d.version }), doctor);
  await app.request(`/staff/bills/${d.id}/payments`, json({ amountPaise: unitPaise, mode: 'upi', reference: 'UPI-1' }), doctor);
  return d.id;
}
/** A refund over the limit (Rs 1,000), waiting for approval; raised by the doctor. */
async function pendingRefund(billId: string, amountPaise = 300_000) {
  const res = await app.request(`/staff/bills/${billId}/refunds`, json({ amountPaise, mode: 'bank', reason: 'Overcharged', reference: 'NEFT1' }), doctor);
  const refund = (await res.json()) as { id: string; status: string };
  expect(refund.status).toBe('pending');
  return refund.id;
}
const decide = async (id: string, verb: 'approve' | 'reject', body: unknown = {}, who = head) => {
  const res = await app.request(`/admin/refunds/${id}/${verb}`, json(body), who);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const dayClose = async (date: string) =>
  (await (await app.request(`/staff/reports/day-close?date=${date}`, {}, head)).json()) as { refundsPaise: number; netPaise: number };

describe('POST /admin/refunds/{id}/approve', () => {
  it('approves: money comes off the bill, approver and time are kept', async () => {
    const billId = await paidBill(500_000);
    const id = await pendingRefund(billId);
    const { status, body } = await decide(id, 'approve', { note: 'checked with the patient' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id, status: 'approved', approvedBy: 'dev-head-doctor', amountPaise: 300_000 });
    expect(body.approvedAt).toBeTypeOf('string');
    expect(await getBill(billId)).toMatchObject({ paidPaise: 200_000, status: 'part_paid' });
    expect((await decide(id, 'approve')).status).toBe(409);
    expect((await decide(id, 'reject', { reason: 'changed my mind' })).status).toBe(409);
  });

  it('a refund approved late counts in day close on its approval day, not the day it was raised', async () => {
    const billId = await paidBill(500_000);
    const id = await pendingRefund(billId, 250_000);
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db.query('UPDATE refunds SET created_at = $2 WHERE id = $1', [id, old]);
    const today = indiaDate();
    const oldDay = indiaDate(old);
    const before = await dayClose(today);
    expect((await dayClose(oldDay)).refundsPaise).toBe(0);
    await decide(id, 'approve', {}, admin);
    const after = await dayClose(today);
    expect(after.refundsPaise - before.refundsPaise).toBe(250_000);
    expect(after.netPaise - before.netPaise).toBe(-250_000);
    expect((await dayClose(oldDay)).refundsPaise).toBe(0);
  });

  it('a refund approved at once still counts on the day it was raised', async () => {
    const before = await dayClose(indiaDate());
    const billId = await paidBill(50_000);
    await app.request(`/staff/bills/${billId}/refunds`, json({ amountPaise: 20_000, mode: 'cash', reason: 'Overcharged' }), doctor);
    expect((await dayClose(indiaDate())).refundsPaise - before.refundsPaise).toBe(20_000);
  });

  it('403 on a refund you raised or without approval.refund; 404; 409 if the bill no longer holds that much', async () => {
    const billId = await paidBill(500_000);
    const id = await pendingRefund(billId);
    expect((await decide(id, 'approve', {}, doctor)).status).toBe(403);
    await db.query("UPDATE refunds SET created_by = 'dev-head-doctor' WHERE id = $1", [id]);
    expect((await decide(id, 'approve')).status).toBe(403);
    expect((await decide(id, 'reject', { reason: 'not mine to decide' })).status).toBe(403);
    expect((await decide(id, 'approve', {}, admin)).status).toBe(200);
    expect((await decide(randomUUID(), 'approve')).status).toBe(404);
    expect((await decide('nope', 'approve')).status).toBe(404);

    const other = await paidBill(500_000);
    const stuck = await pendingRefund(other);
    await db.query('UPDATE bills SET paid_paise = 100000 WHERE id = $1', [other]);
    expect((await decide(stuck, 'approve')).status).toBe(409);
    expect((await db.query('SELECT status FROM refunds WHERE id = $1', [stuck])).rows[0]).toMatchObject({ status: 'pending' });
  });
});

describe('POST /admin/refunds/{id}/reject', () => {
  it('rejects: the bill keeps what it was paid, day close does not count it, the held amount is free again', async () => {
    const billId = await paidBill(500_000);
    const id = await pendingRefund(billId);
    const before = await dayClose(indiaDate());
    const { status, body } = await decide(id, 'reject', { reason: 'not a valid refund' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ id, status: 'rejected' });
    expect(await getBill(billId)).toMatchObject({ paidPaise: 500_000 });
    expect((await dayClose(indiaDate())).refundsPaise).toBe(before.refundsPaise);
    const history = await db.query('SELECT reason FROM refunds_versions WHERE record_id = $1', [id]);
    expect(history.rows[0]).toMatchObject({ reason: 'not a valid refund' });
    const again = await app.request(`/staff/bills/${billId}/refunds`, json({ amountPaise: 500_000, mode: 'cash', reason: 'Overcharged' }), doctor);
    expect(again.status).toBe(201);
  });

  it('422 for a short or missing reason; 403 without approval.refund; the refund stays pending', async () => {
    const id = await pendingRefund(await paidBill(500_000));
    expect((await decide(id, 'reject', { reason: 'no' })).status).toBe(422);
    expect((await decide(id, 'reject', {})).status).toBe(422);
    expect((await decide(id, 'reject', { reason: 'not a valid refund' }, doctor)).status).toBe(403);
    expect((await db.query('SELECT status FROM refunds WHERE id = $1', [id])).rows[0]).toMatchObject({ status: 'pending' });
  });
});
