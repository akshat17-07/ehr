import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { toBatch, type Batch } from '../inventory/batches.js';
import { ITEM_KINDS, ITEMS, toItem, type Item } from '../inventory/items.js';
import { toStockCount, type StockCount } from '../inventory/counts.js';
import { SOURCES, type Line } from '../inventory/movements.js';

// Inventory reports for Admin / Head Doctor (api-list.md #302-#304). Read-only; nothing here changes stock.

const DAY = 86_400_000;
const holders = (n: number) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ');

async function itemsById(db: Queryable, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const { rows } = await db.query(`${ITEMS} WHERE i.id IN (${holders(part.length)})`, part);
    for (const r of rows) out.set(String(r.id), r);
  }
  return out;
}

// ---- #302 stock valuation

export const valuationQuery = z.object({ on: z.iso.date().optional(), kind: z.enum(ITEM_KINDS).optional() }).strict();

export interface ValuationRow {
  item: Item;
  qty: number;
  costValuePaise: number;
  mrpValuePaise: number;
}

/** What each batch took in (+) or sent out (-) since `since`. Quarantine keeps stock on hand, so it is left out. */
async function movedSince(db: Queryable, since: Date): Promise<Map<string, number>> {
  const moved = new Map<string, number>();
  for (const source of SOURCES.filter((s) => s.kind !== 'quarantine')) {
    const time = source.sql.includes('dispensed_at') ? 'dispensed_at' : 'created_at';
    const glue = source.sql.includes(' WHERE ') ? 'AND' : 'WHERE';
    const { rows } = await db.query(`${source.sql} ${glue} ${time} >= $1`, [since]);
    for (const row of rows) {
      for (const line of JSON.parse(String(row.lines)) as Line[]) {
        if (!line.batchId) continue;
        const qty = source.sign * (source.qty ?? ((l: Line) => l.qty))(line);
        moved.set(line.batchId, (moved.get(line.batchId) ?? 0) + qty);
      }
    }
  }
  return moved;
}

/** #302: on-hand quantity x cost (and x MRP) per item on a day (default today), in paise. Items with no stock are left out. */
export async function stockValuation(db: Queryable, query: z.infer<typeof valuationQuery>, now = new Date()) {
  const today = indiaDate(now);
  const on = query.on ?? today;
  if (on > today) throw new AppError(422, 'validation_failed', 'on: not in the future');
  const { rows } = await db.query('SELECT batches.*, expiry::text AS expiry_text FROM batches');
  const moved = on < today ? await movedSince(db, new Date(indiaDayStart(on).getTime() + DAY)) : new Map<string, number>();
  const perItem = new Map<string, { qty: number; cost: number; mrp: number }>();
  for (const r of rows) {
    const batch = toBatch(r, today);
    const qty = batch.qtyOnHand - (moved.get(batch.id) ?? 0);
    if (qty <= 0) continue;
    const total = perItem.get(batch.itemId) ?? { qty: 0, cost: 0, mrp: 0 };
    perItem.set(batch.itemId, { qty: total.qty + qty, cost: total.cost + qty * batch.costPaise, mrp: total.mrp + qty * batch.mrpPaise });
  }
  const items = await itemsById(db, [...perItem.keys()]);
  const out: ValuationRow[] = [];
  for (const [id, t] of perItem) {
    const itemRow = items.get(id);
    if (!itemRow || (query.kind && itemRow.kind !== query.kind)) continue;
    out.push({ item: toItem(itemRow, { qtyOnHand: t.qty, qtyUsable: t.qty }), qty: t.qty, costValuePaise: t.cost, mrpValuePaise: t.mrp });
  }
  out.sort((a, b) => (a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : a.item.id < b.item.id ? -1 : 1));
  return {
    on,
    rows: out,
    totals: {
      qty: out.reduce((s, r) => s + r.qty, 0),
      costValuePaise: out.reduce((s, r) => s + r.costValuePaise, 0),
      mrpValuePaise: out.reduce((s, r) => s + r.mrpValuePaise, 0),
    },
  };
}

// ---- #303 expiry

export const expiryQuery = z
  .object({ withinDays: z.coerce.number().int().min(0).max(365).optional(), days: z.coerce.number().int().min(0).max(365).optional() })
  .strict();

export interface ExpiryRow {
  item: Item;
  batch: Batch;
  expiry: string;
  qty: number;
  expired: boolean;
}

/** #303: batches holding stock that expire within withinDays (default 90; `days` also accepted) or already have, first to expire first. */
export async function expiryReport(db: Queryable, query: z.infer<typeof expiryQuery>, now = new Date()): Promise<ExpiryRow[]> {
  const today = indiaDate(now);
  const until = indiaDate(new Date(indiaDayStart(today).getTime() + (query.withinDays ?? query.days ?? 90) * DAY));
  const { rows } = await db.query(
    `SELECT batches.*, expiry::text AS expiry_text FROM batches WHERE qty_on_hand > 0 AND expiry <= $1 ORDER BY expiry, batch_no, id`,
    [until],
  );
  const items = await itemsById(db, [...new Set(rows.map((r) => String(r.item_id)))]);
  return rows.flatMap((r) => {
    const itemRow = items.get(String(r.item_id));
    if (!itemRow) return [];
    const batch = toBatch(r, today);
    return [
      {
        item: toItem(itemRow, { qtyOnHand: batch.qtyOnHand, qtyUsable: batch.qtyUsable }),
        batch,
        expiry: batch.expiry,
        qty: batch.qtyOnHand,
        expired: batch.expiry < today,
      },
    ];
  });
}

// ---- #304 stock variance

export const varianceQuery = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional(), itemId: z.uuid().optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from is after to', path: ['to'] });

export interface VarianceRow {
  count: StockCount;
  item: Item;
  batch: Batch;
  bookQty: number;
  countedQty: number;
  difference: number;
  /** difference x the batch's cost, in paise (below 0 is stock lost). */
  differencePaise: number;
}

/** #304: the differences found by stock counts (newest count first, at most 200 counts), for review. Lines that matched are left out. */
export async function stockVariance(db: Queryable, query: z.infer<typeof varianceQuery>, now = new Date()): Promise<VarianceRow[]> {
  const where: string[] = ['voided_at IS NULL'];
  const params: unknown[] = [];
  if (query.from) where.push(`created_at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`created_at < $${params.push(new Date(indiaDayStart(query.to).getTime() + DAY))}`);
  const { rows } = await db.query(`SELECT * FROM stock_counts WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 200`, params);
  const counts = rows.map(toStockCount);
  const batchIds = [...new Set(counts.flatMap((c) => c.lines.filter((l) => l.difference !== 0).map((l) => l.batchId)))];
  const today = indiaDate(now);
  const batches = new Map<string, Batch>();
  for (let i = 0; i < batchIds.length; i += 400) {
    const part = batchIds.slice(i, i + 400);
    const { rows: found } = await db.query(`SELECT batches.*, expiry::text AS expiry_text FROM batches WHERE id IN (${holders(part.length)})`, part);
    for (const r of found) batches.set(String(r.id), toBatch(r, today));
  }
  const items = await itemsById(db, [...new Set([...batches.values()].map((b) => b.itemId))]);
  return counts.flatMap((count) =>
    count.lines.flatMap((line) => {
      const batch = batches.get(line.batchId);
      const itemRow = batch && items.get(batch.itemId);
      if (line.difference === 0 || !batch || !itemRow || (query.itemId && batch.itemId !== query.itemId)) return [];
      return [
        {
          count,
          item: toItem(itemRow, { qtyOnHand: batch.qtyOnHand, qtyUsable: batch.qtyUsable }),
          batch,
          bookQty: line.bookQty,
          countedQty: line.countedQty,
          difference: line.difference,
          differencePaise: line.difference * batch.costPaise,
        },
      ];
    }),
  );
}
