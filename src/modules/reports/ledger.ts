import { z } from 'zod';
import { pageQuery, pageRows, type Page } from '../../db/page.js';
import type { Queryable } from '../../db/migrate.js';
import { indiaDayStart } from '../../time/india.js';

// #347 GET /admin/ledger: a read-only ledger derived from the existing tables (no table of its own). Money is integer paise.
// Voided rows (voided_at set) are left out of every source. The time of an entry follows the same definitions as the
// collections report (#234) and day close (#130), so the money accounts add up to its collected less refunded.
//
// Accounts:
//   cash, upi, card, bank  money accounts, named after the payment mode. Debit: a payment (not from a deposit) or a
//                          deposit taken. Credit: a refund paid out (approved or paid), at COALESCE(approved_at, created_at).
//                          Net (debit - credit) of these for a day = collected - refunded in #234.
//   receivables            Debit: a bill finalised (final, paid, part_paid) at COALESCE(finalised_at, created_at), = its total;
//                          a refund (it reopens the bill). Credit: a payment (any mode, including from a deposit).
//   deposits               Credit: a deposit taken. Debit: a payment made from a deposit (mode 'deposit').
//   pharmacy               Debit: a pharmacy bill (total). Credit: a pharmacy return (refund_paise). Single entry: pharmacy
//                          counter money is not in #234, so it has no money-account row.
//   venue_expense          Debit: a payment to a partner hospital (#92), at 00:00 India time of paid_on. Single entry.

export const LEDGER_ACCOUNTS = ['cash', 'upi', 'card', 'bank', 'receivables', 'deposits', 'pharmacy', 'venue_expense'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
export const ledgerQuery = pageQuery
  .extend({ from: z.iso.date(), to: z.iso.date(), account: z.enum(LEDGER_ACCOUNTS).optional() })
  .strict()
  .refine((q) => q.from <= q.to && (indiaDayStart(q.to).getTime() - indiaDayStart(q.from).getTime()) / DAY_MS < 366, {
    message: 'from must not be after to, and the range is at most 366 days',
    path: ['to'],
  });

export interface LedgerEntry {
  at: string;
  account: string;
  debitPaise: number;
  creditPaise: number;
  ref: string;
  memo: string;
}

const BILL_AT = 'COALESCE(b.finalised_at, b.created_at)';
const REFUND_AT = 'COALESCE(r.approved_at, r.created_at)';
const VENUE_AT = "(v.paid_on::timestamp AT TIME ZONE 'Asia/Kolkata')";
const W = (col: string) => `${col} >= $1 AND ${col} < $2`;

// Columns: id (unique text), ts, account, debit, credit, ref, memo.
const SOURCES = `
  SELECT b.id::text || ':bill' AS id, ${BILL_AT} AS ts, 'receivables' AS account, b.total_paise AS debit, 0 AS credit, COALESCE(b.number, b.id::text) AS ref, 'Bill finalised' AS memo
    FROM bills b WHERE b.voided_at IS NULL AND b.status IN ('final', 'paid', 'part_paid') AND ${W(BILL_AT)}
  UNION ALL
  SELECT p.id::text || ':pay', p.created_at, CASE WHEN p.mode = 'deposit' THEN 'deposits' ELSE p.mode END, p.amount_paise, 0, p.bill_id::text,
         CASE WHEN p.mode = 'deposit' THEN 'Payment from deposit' ELSE 'Payment received' END
    FROM payments p WHERE p.voided_at IS NULL AND ${W('p.created_at')}
  UNION ALL
  SELECT p.id::text || ':rec', p.created_at, 'receivables', 0, p.amount_paise, p.bill_id::text, 'Payment against bill'
    FROM payments p WHERE p.voided_at IS NULL AND ${W('p.created_at')}
  UNION ALL
  SELECT d.id::text || ':dep', d.created_at, d.mode, d.amount_paise, 0, d.receipt_no, 'Deposit taken'
    FROM deposits d WHERE d.voided_at IS NULL AND ${W('d.created_at')}
  UNION ALL
  SELECT d.id::text || ':dpl', d.created_at, 'deposits', 0, d.amount_paise, d.receipt_no, 'Deposit taken'
    FROM deposits d WHERE d.voided_at IS NULL AND ${W('d.created_at')}
  UNION ALL
  SELECT r.id::text || ':ref', ${REFUND_AT}, r.mode, 0, r.amount_paise, r.bill_id::text, 'Refund paid'
    FROM refunds r WHERE r.voided_at IS NULL AND r.status IN ('approved', 'paid') AND ${W(REFUND_AT)}
  UNION ALL
  SELECT r.id::text || ':rrc', ${REFUND_AT}, 'receivables', r.amount_paise, 0, r.bill_id::text, 'Refund against bill'
    FROM refunds r WHERE r.voided_at IS NULL AND r.status IN ('approved', 'paid') AND ${W(REFUND_AT)}
  UNION ALL
  SELECT h.id::text || ':ph', h.created_at, 'pharmacy', h.total_paise, 0, COALESCE(h.number, h.id::text), 'Pharmacy bill'
    FROM pharmacy_bills h WHERE h.voided_at IS NULL AND ${W('h.created_at')}
  UNION ALL
  SELECT x.id::text || ':phr', x.created_at, 'pharmacy', 0, x.refund_paise, COALESCE(x.bill_id, x.dispense_id)::text, 'Pharmacy return'
    FROM pharmacy_returns x WHERE x.voided_at IS NULL AND ${W('x.created_at')}
  UNION ALL
  SELECT v.id::text || ':ven', ${VENUE_AT}, 'venue_expense', v.amount_paise, 0, COALESCE(v.reference, v.surgery_id::text), 'Venue payment'
    FROM venue_payments v WHERE v.voided_at IS NULL AND ${W(VENUE_AT)}`;

export async function ledger(db: Queryable, query: z.infer<typeof ledgerQuery>): Promise<Page<LedgerEntry>> {
  const start = indiaDayStart(query.from);
  const end = new Date(indiaDayStart(query.to).getTime() + DAY_MS);
  const params: unknown[] = [start, end];
  const where: string[] = [];
  if (query.account) where.push(`l.account = $${params.push(query.account)}`);
  return pageRows(
    db,
    {
      select: `SELECT l.id, l.ts, l.account, l.debit::text AS debit, l.credit::text AS credit, l.ref, l.memo FROM (${SOURCES}) l`,
      where,
      params,
      orderBy: ['l.ts', 'l.id'],
      direction: 'asc',
    },
    query,
    (r) => ({
      at: (r.ts as Date).toISOString(),
      account: String(r.account),
      debitPaise: Number(r.debit),
      creditPaise: Number(r.credit),
      ref: String(r.ref),
      memo: String(r.memo),
    }),
  );
}
