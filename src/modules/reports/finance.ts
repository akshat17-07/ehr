import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { indiaDayStart } from '../../time/india.js';

// Admin finance reports (api-list.md #233 SurgeryMargin, #234 Collections). All money is integer paise.

const DAY_MS = 24 * 60 * 60 * 1000;

const range = z.object({ from: z.iso.date(), to: z.iso.date() });
const checkRange = (q: { from: string; to: string }) => q.from <= q.to && (indiaDayStart(q.to).getTime() - indiaDayStart(q.from).getTime()) / DAY_MS < 366;
const rangeMessage = { message: 'from must not be after to, and the range is at most 366 days', path: ['to'] };

export const surgeryMarginQuery = range.extend({ surgeonId: z.uuid().optional() }).strict().refine(checkRange, rangeMessage);
export const collectionsQuery = range.extend({ groupBy: z.enum(['day', 'department', 'mode']).default('day') }).strict().refine(checkRange, rangeMessage);

const bounds = (q: { from: string; to: string }): [Date, Date] => [indiaDayStart(q.from), new Date(indiaDayStart(q.to).getTime() + DAY_MS)];

export interface SurgeryMarginRow {
  surgeryId: string;
  surgeryDate: string;
  chargesPaise: number;
  venuePaidPaise: number;
  marginPaise: number;
}
export interface MoneyTotals {
  chargesPaise: number;
  venuePaidPaise: number;
  marginPaise: number;
}

/**
 * #233: per surgery scheduled inside [from, to] (India days): what we charge (surgeries.charges_paise; nothing for a
 * cancelled one) less what was paid to the venue (non-void venue payments, all dates). A cancelled surgery shows only
 * if a cancellation fee was paid. Oldest first.
 */
export async function surgeryMargin(db: Queryable, query: z.infer<typeof surgeryMarginQuery>): Promise<{ rows: SurgeryMarginRow[]; totals: MoneyTotals }> {
  const [start, end] = bounds(query);
  const params: unknown[] = [start, end];
  let surgeon = '';
  if (query.surgeonId) surgeon = ` AND s.surgeon_id = $${params.push(query.surgeonId)}`;
  const { rows: found } = await db.query(
    `SELECT s.id, s.status, s.charges_paise::text AS charges,
            to_char(s.scheduled_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
            COALESCE((SELECT SUM(v.amount_paise) FROM venue_payments v WHERE v.surgery_id = s.id AND v.voided_at IS NULL), 0)::text AS venue_paid
       FROM surgeries s
      WHERE s.voided_at IS NULL AND s.scheduled_at >= $1 AND s.scheduled_at < $2${surgeon}
      ORDER BY s.scheduled_at, s.id`,
    params,
  );
  const rows: SurgeryMarginRow[] = [];
  const totals: MoneyTotals = { chargesPaise: 0, venuePaidPaise: 0, marginPaise: 0 };
  for (const r of found) {
    const cancelled = r.status === 'cancelled';
    const chargesPaise = cancelled ? 0 : Number(r.charges);
    const venuePaidPaise = Number(r.venue_paid);
    if (cancelled && venuePaidPaise === 0) continue;
    const marginPaise = chargesPaise - venuePaidPaise;
    rows.push({ surgeryId: String(r.id), surgeryDate: String(r.day), chargesPaise, venuePaidPaise, marginPaise });
    totals.chargesPaise += chargesPaise;
    totals.venuePaidPaise += venuePaidPaise;
    totals.marginPaise += marginPaise;
  }
  return { rows, totals };
}

export interface CollectionsRow {
  key: string;
  billedPaise: number;
  collectedPaise: number;
  refundedPaise: number;
}

const dayOf = (col: string) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`;
const BILL_DEPARTMENT = `COALESCE(e.department_id::text, a.department_id::text, 'unassigned')`;
const BILL_JOINS = 'LEFT JOIN encounters e ON e.id = b.encounter_id LEFT JOIN admissions a ON a.id = b.admission_id';

/**
 * #234, same definitions as day close (#130). billed: final, paid and part-paid bills (not draft or void) by finalised
 * day. collected: non-void payments except those from a deposit, plus deposits taken, by created day. refunded:
 * approved or paid refunds by COALESCE(approved_at, created_at). Rows are sorted by key.
 * By department a bill is in its encounter's or admission's department; a deposit has none, so it is 'unassigned'.
 * By mode, billed is not derivable (a bill has no mode) and stays 0.
 */
export async function collections(db: Queryable, query: z.infer<typeof collectionsQuery>): Promise<{ rows: CollectionsRow[] }> {
  const [start, end] = bounds(query);
  const params = [start, end];
  const by = query.groupBy;
  const billedAt = 'COALESCE(b.finalised_at, b.created_at)';
  const refundAt = 'COALESCE(r.approved_at, r.created_at)';

  const out = new Map<string, CollectionsRow>();
  const add = (key: string, field: 'billedPaise' | 'collectedPaise' | 'refundedPaise', sum: unknown) => {
    const row = out.get(key) ?? { key, billedPaise: 0, collectedPaise: 0, refundedPaise: 0 };
    row[field] += Number(sum);
    out.set(key, row);
  };

  if (by !== 'mode') {
    const key = by === 'day' ? dayOf(billedAt) : BILL_DEPARTMENT;
    const { rows } = await db.query(
      `SELECT ${key} AS k, SUM(b.total_paise)::text AS sum FROM bills b ${BILL_JOINS}
        WHERE b.voided_at IS NULL AND b.status IN ('final', 'paid', 'part_paid') AND ${billedAt} >= $1 AND ${billedAt} < $2 GROUP BY 1`,
      params,
    );
    for (const r of rows) add(String(r.k), 'billedPaise', r.sum);
  }

  // Payments (not from a deposit: that money was counted when the deposit was taken) and deposits.
  if (by === 'department') {
    const { rows } = await db.query(
      `SELECT ${BILL_DEPARTMENT} AS k, SUM(p.amount_paise)::text AS sum FROM payments p
         JOIN bills b ON b.id = p.bill_id ${BILL_JOINS}
        WHERE p.voided_at IS NULL AND p.mode <> 'deposit' AND p.created_at >= $1 AND p.created_at < $2 GROUP BY 1`,
      params,
    );
    for (const r of rows) add(String(r.k), 'collectedPaise', r.sum);
    const { rows: dep } = await db.query('SELECT COALESCE(SUM(amount_paise), 0)::text AS sum FROM deposits WHERE voided_at IS NULL AND created_at >= $1 AND created_at < $2', params);
    if (Number(dep[0]?.sum) > 0) add('unassigned', 'collectedPaise', dep[0]?.sum);
  } else {
    const key = by === 'day' ? dayOf('created_at') : 'mode';
    for (const table of ['payments', 'deposits']) {
      const { rows } = await db.query(
        `SELECT ${key} AS k, SUM(amount_paise)::text AS sum FROM ${table}
          WHERE voided_at IS NULL${table === 'payments' ? " AND mode <> 'deposit'" : ''} AND created_at >= $1 AND created_at < $2 GROUP BY 1`,
        params,
      );
      for (const r of rows) add(String(r.k), 'collectedPaise', r.sum);
    }
  }

  const refundKey = by === 'day' ? dayOf(refundAt) : by === 'department' ? BILL_DEPARTMENT : 'r.mode';
  const joins = by === 'department' ? `JOIN bills b ON b.id = r.bill_id ${BILL_JOINS}` : '';
  const { rows: refunds } = await db.query(
    `SELECT ${refundKey} AS k, SUM(r.amount_paise)::text AS sum FROM refunds r ${joins}
      WHERE r.voided_at IS NULL AND r.status IN ('approved', 'paid') AND ${refundAt} >= $1 AND ${refundAt} < $2 GROUP BY 1`,
    params,
  );
  for (const r of refunds) add(String(r.k), 'refundedPaise', r.sum);

  return { rows: [...out.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
