import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedId } from '../src/db/table.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);
const receptionId = seedId('a0000000', 6);
const patient = seedId('9a710000', 1);
const other = seedId('9a710000', 2);
const { rows: p } = await db.query('SELECT uhid FROM patients WHERE id = $1', [patient]);
const uhid = String(p[0]?.uhid);

// Each row a minute after the last, so the order is fixed.
let minute = 0;
const at = () => new Date(Date.UTC(2026, 10, 1, 4, minute++));
const insert = async (table: string, by: string, columns: Record<string, unknown>, status = 'pending') => {
  const id = randomUUID();
  const names = Object.keys(columns);
  await db.query(
    `INSERT INTO ${table} (id, status, created_by, updated_by, created_at, ${names.join(', ')})
     VALUES ($1, $2, $3, $3, $4, ${names.map((_, i) => `$${i + 5}`).join(', ')})`,
    [id, status, by, at(), ...Object.values(columns)],
  );
  return id;
};

const access = await insert('access_requests', 'dev-reception', { patient_id: patient, requested_by: 'dev-reception', reason: 'old file for follow-up' });
const refund = await insert('refunds', 'dev-billing', { bill_id: randomUUID(), patient_id: patient, amount_paise: 250000, mode: 'cash', reason: 'test not done' });
const ownRefund = await insert('refunds', 'dev-admin', { bill_id: randomUUID(), patient_id: patient, amount_paise: 100, mode: 'cash', reason: 'own one' });
const discount = await insert('discounts', 'dev-billing', { bill_id: randomUUID(), amount_paise: 50000, reason: 'staff family' });
const payroll = await insert('payroll_runs', 'dev-billing', { month: '2026-10', total_net_paise: 12345600, run_by: 'dev-billing' }, 'draft');
const merge = await insert('patient_merges', 'dev-reception', { keep_patient_id: patient, merge_patient_id: other, reason: 'same person twice', proposed_by: 'dev-reception' });
await insert('refunds', 'dev-billing', { bill_id: randomUUID(), patient_id: patient, amount_paise: 100, mode: 'cash', reason: 'done' }, 'approved');

type Approval = { kind: string; id: string; summary: string; requestedBy: string; requestedByName?: string };
const list = async (query = '', who = admin) => {
  const res = await app.request(`/admin/approvals${query}`, {}, who);
  return { status: res.status, body: (await res.json()) as Approval[] };
};

describe('GET /admin/approvals', () => {
  it('lists every waiting item this user may decide, oldest first, without their own', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.map((a) => a.id)).toEqual([access, refund, discount, payroll, merge]);
    expect(body.map((a) => a.id)).not.toContain(ownRefund);
    expect(body[0]).toMatchObject({ kind: 'access_request', requestedBy: receptionId, requestedByName: 'Pooja Patel', summary: `Open the record of ${uhid}: old file for follow-up` });
    expect(body[1]!.summary).toBe(`Refund ₹2,500.00 to ${uhid}: test not done`);
    expect(body[3]!.summary).toBe('Payroll for 2026-10: ₹1,23,456.00 net');
  });

  it('filters by kind; the person who asked does not see it', async () => {
    expect((await list('?kind=refund')).body.map((a) => a.id)).toEqual([refund]);
    expect((await list('?kind=refund', head)).body.map((a) => a.id)).toEqual([refund, ownRefund]);
    expect((await list('?kind=nope')).status).toBe(422);
  });

  it('403 without approval.view', async () => {
    expect((await list('', asStaff('dev-doctor', ['doctor']))).status).toBe(403);
  });
});
