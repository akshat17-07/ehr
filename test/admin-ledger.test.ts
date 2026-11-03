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
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);
const get = (path: string, who = admin) => app.request(path, {}, who);
const patient = seedId('9a710000', 1);

interface Entry { at: string; account: string; debitPaise: number; creditPaise: number; ref: string; memo: string }
const list = async (q: string) => (await (await get(`/admin/ledger?${q}`)).json()) as { items: Entry[]; nextCursor?: string };

// Fixture day: 2025-02-10 India (2025-02-09T18:30Z to 2025-02-10T18:30Z).
const Q = 'from=2025-02-10&to=2025-02-10';
const ins = async (sql: string, params: unknown[]) => String((await db.query(sql, params)).rows[0]?.id ?? '');
const bill = (status: string, total: number, at: string, number: string, voided = false) =>
  ins(
    `INSERT INTO bills (id, status, created_by, updated_by, created_at, updated_at, voided_at, patient_id, series, lines, subtotal_paise, gst_paise, total_paise, finalised_at, number)
     VALUES (gen_random_uuid(), $1, 'x', 'x', $2, $2, $3, $4, 'tax_invoice', '[]', $5, 0, $5, $2, $6) RETURNING id`,
    [status, at, voided ? at : null, patient, total, number],
  );
const pay = (billId: string, amount: number, mode: string, at: string, voided = false) =>
  db.query(
    `INSERT INTO payments (id, status, created_by, updated_by, created_at, updated_at, voided_at, bill_id, patient_id, amount_paise, mode)
     VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $1, $2, $3, $4, $5, $6)`,
    [at, voided ? at : null, billId, patient, amount, mode],
  );

describe('GET /admin/ledger', () => {
  it('each source once with the right account and sign, voided left out, agrees with collections', async () => {
    const b = await bill('part_paid', 100_001, '2025-02-10T04:00:00Z', 'L-1');
    await bill('draft', 999, '2025-02-10T04:00:00Z', 'L-D');
    await bill('void', 888, '2025-02-10T04:00:00Z', 'L-V', true);
    await pay(b, 40_000, 'cash', '2025-02-10T05:00:00Z');
    await pay(b, 30_001, 'upi', '2025-02-10T06:00:00Z');
    await pay(b, 7_777, 'card', '2025-02-10T06:30:00Z', true);
    await pay(b, 20_000, 'deposit', '2025-02-10T07:00:00Z');
    await db.query(
      `INSERT INTO deposits (id, status, created_by, updated_by, created_at, updated_at, patient_id, receipt_no, amount_paise, balance_paise, mode)
       VALUES (gen_random_uuid(), 'active', 'x', 'x', '2025-02-10T08:00:00Z', '2025-02-10T08:00:00Z', $1, 'R-L-1', 25000, 5000, 'card')`,
      [patient],
    );
    const refund = (amount: number, mode: string, at: string, approvedAt: string | null, status = 'approved', voided = false) =>
      db.query(
        `INSERT INTO refunds (id, status, created_by, updated_by, created_at, updated_at, voided_at, approved_at, bill_id, patient_id, amount_paise, mode, reason)
         VALUES (gen_random_uuid(), $6, 'x', 'x', $1, $1, $7, $2, $3, $4, $5, $8, 'r')`,
        [at, approvedAt, b, patient, amount, status, voided ? at : null, mode],
      );
    await refund(10_000, 'cash', '2025-02-10T09:00:00Z', null);
    await refund(5_000, 'upi', '2025-02-08T09:00:00Z', '2025-02-10T09:30:00Z', 'paid'); // approved on the day
    await refund(4_000, 'cash', '2025-02-10T09:00:00Z', null, 'pending');
    await refund(3_000, 'cash', '2025-02-10T09:00:00Z', null, 'approved', true);
    await db.query(
      `INSERT INTO pharmacy_bills (id, status, created_by, updated_by, created_at, updated_at, patient_id, setting, number, lines, total_paise, gst_paise)
       VALUES (gen_random_uuid(), 'active', 'x', 'x', '2025-02-10T10:00:00Z', '2025-02-10T10:00:00Z', $1, 'opd', 'PH-L-1', '[]', 12345, 0)`,
      [patient],
    );
    await db.query(
      `INSERT INTO pharmacy_returns (id, status, created_by, updated_by, created_at, updated_at, dispense_id, patient_id, lines, reason, refund_paise, refund_mode, bill_id)
       VALUES (gen_random_uuid(), 'active', 'x', 'x', '2025-02-10T11:00:00Z', '2025-02-10T11:00:00Z', gen_random_uuid(), $1, '[]', 'r', 2345, 'cash', $2)`,
      [patient, seedId('9a710000', 99)],
    );
    const venue = (amount: number, paidOn: string, voided = false) =>
      db.query(
        `INSERT INTO venue_payments (id, status, created_by, updated_by, voided_at, surgery_id, partner_hospital_id, amount_paise, paid_on, mode, reference)
         VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, gen_random_uuid(), gen_random_uuid(), $2, $3, 'bank', 'UTR-1')`,
        [voided ? '2025-02-10T00:00:00Z' : null, amount, paidOn],
      );
    await venue(50_000, '2025-02-10');
    await venue(1_111, '2025-02-10', true);
    await venue(2_222, '2025-02-11');

    const { items, nextCursor } = await list(`${Q}&limit=100`);
    expect(nextCursor).toBeUndefined();
    const sig = (e: Entry) => `${e.account}|${e.debitPaise}|${e.creditPaise}|${e.memo}`;
    expect(items.map(sig).sort()).toEqual(
      [
        'receivables|100001|0|Bill finalised',
        'cash|40000|0|Payment received',
        'receivables|0|40000|Payment against bill',
        'upi|30001|0|Payment received',
        'receivables|0|30001|Payment against bill',
        'deposits|20000|0|Payment from deposit',
        'receivables|0|20000|Payment against bill',
        'card|25000|0|Deposit taken',
        'deposits|0|25000|Deposit taken',
        'cash|0|10000|Refund paid',
        'receivables|10000|0|Refund against bill',
        'upi|0|5000|Refund paid',
        'receivables|5000|0|Refund against bill',
        'pharmacy|12345|0|Pharmacy bill',
        'pharmacy|0|2345|Pharmacy return',
        'venue_expense|50000|0|Venue payment',
      ].sort(),
    );
    expect(items.find((e) => e.account === 'venue_expense')).toMatchObject({ at: '2025-02-09T18:30:00.000Z', ref: 'UTR-1' });
    expect(items.find((e) => e.memo === 'Bill finalised')?.ref).toBe('L-1');
    const times = items.map((e) => e.at);
    expect([...times].sort()).toEqual(times);

    // Money accounts net = collections collected less refunded for the day.
    const net = items.filter((e) => ['cash', 'upi', 'card', 'bank'].includes(e.account)).reduce((s, e) => s + e.debitPaise - e.creditPaise, 0);
    const col = (await (await get('/admin/reports/collections?from=2025-02-10&to=2025-02-10')).json()) as { rows: { collectedPaise: number; refundedPaise: number }[] };
    expect(col.rows).toHaveLength(1);
    expect(net).toBe(col.rows[0]!.collectedPaise - col.rows[0]!.refundedPaise);
    expect(net).toBe(40_000 + 30_001 + 25_000 - 15_000);

    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'ledger' AND reason LIKE 'ledger from=2025-02-10 to=2025-02-10%'");
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('account filter and paging', async () => {
    const only = await list(`${Q}&account=receivables`);
    expect(only.items.length).toBeGreaterThan(0);
    expect(only.items.every((e) => e.account === 'receivables')).toBe(true);
    const all = await list(`${Q}&limit=100`);
    const key = (e: Entry) => `${e.at}|${e.account}|${e.debitPaise}|${e.creditPaise}|${e.memo}`;
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(`${Q}&limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map(key));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all.items.map(key));
    expect((await list('from=2001-01-01&to=2001-01-31')).items).toEqual([]);
  });

  it('403 and 422', async () => {
    expect((await get(`/admin/ledger?${Q}`, doctor)).status).toBe(403);
    for (const q of ['from=2025-02-12&to=2025-02-10', 'from=2025-02-10', 'to=2025-02-10', 'from=2023-01-01&to=2025-02-10', `${Q}&account=nope`, `${Q}&limit=0`, `${Q}&cursor=zzz`]) {
      expect((await get(`/admin/ledger?${q}`)).status).toBe(422);
    }
    expect((await get('/admin/ledger?from=2024-01-01&to=2024-12-31')).status).toBe(200);
  });
});
