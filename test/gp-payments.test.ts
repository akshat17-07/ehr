import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// #273 (todo 406): /other/gp/payments shows payment status only; registration with a referrer adds a referral;
// /hospital and /me/permissions exist for the gp and insurance groups.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const gp = asStaff('dev-gp', ['gp']);
const insurance = asStaff('dev-insurance', ['insurance']);
const reception = asStaff('dev-reception', ['staff']);
const doctor = asStaff('dev-doctor', ['doctor']);

const gpUserId = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-gp'")).rows[0]?.id);
const [p1, p2, p3, p4, p5] = [1, 2, 3, 4, 5].map((n) => seedId('9a710000', n)) as [string, string, string, string, string];

async function referrer(userId: string | null) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO referrers (id, status, created_by, updated_by, name, name_search, user_id, pseudo)
     VALUES ($1, 'active', 'test', 'test', 'Dr Test', 'dr test', $2, false)`,
    [id, userId],
  );
  return id;
}
async function referral(referrerId: string, patientId: string, date: string) {
  await db.query(
    `INSERT INTO referrals (id, status, created_at, updated_at, created_by, updated_by, patient_id, referrer_id, referral_date)
     VALUES ($4, 'received', '2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z', 'x', 'x', $1, $2, $3)`,
    [patientId, referrerId, date, randomUUID()],
  );
}
let n = 0;
async function bill(patient: string, status: string, at: string, voided = false) {
  n++;
  await db.query(
    `INSERT INTO bills (id, status, created_by, updated_by, created_at, updated_at, voided_at, patient_id, series, lines, subtotal_paise, gst_paise, total_paise, finalised_at, number)
     VALUES ($6, $1, 'x', 'x', $2, $2, $3, $4, 'tax_invoice', '[]', 1000, 0, 1000, $2, $5)`,
    [status, at, voided ? at : null, patient, status === 'draft' ? null : `B-${n}`, randomUUID()],
  );
}

const mine = await referrer(gpUserId);
const theirs = await referrer(null);
// p1: final + paid -> part_paid; p2: all paid; p3: only draft/void/old bills -> none; p4: final only -> unpaid
await referral(mine, p1, '2026-02-10');
await referral(mine, p2, '2026-02-11');
await referral(mine, p3, '2026-02-12');
await referral(mine, p4, '2026-02-13');
await referral(theirs, p5, '2026-02-14');
await bill(p1, 'final', '2026-02-15T05:00:00Z');
await bill(p1, 'paid', '2026-02-16T05:00:00Z');
await bill(p2, 'paid', '2026-02-20T05:00:00Z');
await bill(p3, 'draft', '2026-02-20T05:00:00Z');
await bill(p3, 'void', '2026-02-20T05:00:00Z', true);
await bill(p3, 'paid', '2026-02-01T05:00:00Z'); // before the referral date
await bill(p4, 'final', '2026-02-20T05:00:00Z');
await bill(p5, 'paid', '2026-02-20T05:00:00Z');

type Item = { referralId: string; patientName: string; referralDate: string; bills: { number?: string; date: string; status: string }[]; paymentStatus: string };
const list = async (q = '', who = gp) => (await (await app.request(`/other/gp/payments${q}`, {}, who)).json()) as { items: Item[]; nextCursor?: string };
const statusOf = (items: Item[], date: string) => items.find((i) => i.referralDate === date)?.paymentStatus;

describe('GET /other/gp/payments', () => {
  it('shows own referrals newest first with computed payment status and no amounts', async () => {
    const { items } = await list();
    expect(items.map((i) => i.referralDate)).toEqual(['2026-02-13', '2026-02-12', '2026-02-11', '2026-02-10']);
    expect(statusOf(items, '2026-02-10')).toBe('part_paid');
    expect(statusOf(items, '2026-02-11')).toBe('paid');
    expect(statusOf(items, '2026-02-12')).toBe('none');
    expect(statusOf(items, '2026-02-13')).toBe('unpaid');
    expect(items.find((i) => i.referralDate === '2026-02-10')!.bills).toEqual([
      { number: expect.any(String), date: '2026-02-15', status: 'final' },
      { number: expect.any(String), date: '2026-02-16', status: 'paid' },
    ]);
    expect(items.find((i) => i.referralDate === '2026-02-12')!.bills).toEqual([]);
    expect(JSON.stringify(items)).not.toMatch(/paise|amount|total|percent|commission/i);
  });

  it('never shows another GP patient; filters by status; pages', async () => {
    const { items } = await list();
    expect(items.some((i) => i.referralDate === '2026-02-14')).toBe(false);
    expect((await list('?status=paid')).items.map((i) => i.referralDate)).toEqual(['2026-02-11']);
    expect((await list('?status=none')).items.map((i) => i.referralDate)).toEqual(['2026-02-12']);
    const first = await list('?limit=3');
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    expect((await list(`?limit=3&cursor=${first.nextCursor}`)).items.map((i) => i.referralDate)).toEqual(['2026-02-10']);
    expect((await app.request('/other/gp/payments?status=bad', {}, gp)).status).toBe(422);
  });

  it('refuses a non-GP', async () => {
    expect((await app.request('/other/gp/payments', {}, doctor)).status).toBe(403);
  });
});

describe('registration with a referrer', () => {
  it('adds a received referral the GP can see', async () => {
    const res = await app.request(
      '/staff/patients',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Geeta Bai', sex: 'F', ageYears: 50, referrerId: mine }) },
      reception,
    );
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    const rows = (await db.query('SELECT status, reason FROM referrals WHERE referrer_id = $1 AND patient_id = $2', [mine, id])).rows;
    expect(rows).toEqual([{ status: 'received', reason: null }]);
    const seen = (await (await app.request('/other/gp/referrals', {}, gp)).json()) as { items: { patientName: string }[] };
    expect(seen.items.some((i) => i.patientName === 'Geeta Bai')).toBe(true);
    const pay = await list();
    expect(pay.items.find((i) => i.patientName === 'Geeta Bai')?.paymentStatus).toBe('none');
  });
});

describe('hospital and permissions for gp and insurance', () => {
  it.each([['gp', gp], ['insurance', insurance]])('%s', async (group, who) => {
    const staff = (await (await app.request('/staff/hospital', {}, reception)).json()) as object;
    const h = await app.request(`/other/${group}/hospital`, {}, who);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual(staff);
    const p = await app.request(`/other/${group}/me/permissions`, {}, who);
    expect(p.status).toBe(200);
    expect(((await p.json()) as { permissions: unknown[] }).permissions).toEqual([]);
    expect((await app.request(`/other/${group}/hospital`, {}, doctor)).status).toBe(403);
  });
});
