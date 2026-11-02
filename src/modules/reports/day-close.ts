import type { Queryable } from '../../db/migrate.js';
import { indiaDayStart } from '../../time/india.js';

/**
 * #130 (api-list.md DayClose): the billing counter's money for one India day. cash, upi and card are money taken
 * (bill payments and deposits); deposit is bills paid from deposits taken before, so it is not new money.
 * netPaise = cash + upi + card - approved refunds. With userId, only what that person took and refunded.
 */
export interface DayClose {
  date: string;
  byMode: { cash: number; upi: number; card: number; deposit: number };
  byUser: { userId: string; totalPaise: number }[];
  refundsPaise: number;
  netPaise: number;
}

export async function dayClose(db: Queryable, query: { date: string; userId?: string }): Promise<DayClose> {
  const from = indiaDayStart(query.date);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  const params: unknown[] = [from, to, ...(query.userId ? [query.userId] : [])];
  const byWho = query.userId ? ' AND created_by = $3' : '';
  const window = `created_at >= $1 AND created_at < $2${byWho}`;
  const { rows } = await db.query(
    `SELECT created_by, mode, SUM(amount_paise)::text AS sum FROM (
       SELECT created_by, mode, amount_paise FROM payments WHERE voided_at IS NULL AND ${window}
       UNION ALL
       SELECT created_by, mode, amount_paise FROM deposits WHERE voided_at IS NULL AND ${window}
     ) money GROUP BY created_by, mode`,
    params,
  );
  const byMode = { cash: 0, upi: 0, card: 0, deposit: 0 };
  const users = new Map<string, number>();
  for (const r of rows) {
    const mode = String(r.mode) as keyof typeof byMode;
    const amount = Number(r.sum);
    byMode[mode] += amount;
    if (mode !== 'deposit') users.set(String(r.created_by), (users.get(String(r.created_by)) ?? 0) + amount);
  }
  const { rows: refundRows } = await db.query(
    `SELECT COALESCE(SUM(amount_paise), 0)::text AS sum FROM refunds WHERE status IN ('approved', 'paid') AND voided_at IS NULL AND ${window}`,
    params,
  );
  const refundsPaise = Number(refundRows[0]?.sum ?? 0);
  return {
    date: query.date,
    byMode,
    byUser: [...users].map(([userId, totalPaise]) => ({ userId, totalPaise })).sort((a, b) => a.userId.localeCompare(b.userId)),
    refundsPaise,
    netPaise: byMode.cash + byMode.upi + byMode.card - refundsPaise,
  };
}
