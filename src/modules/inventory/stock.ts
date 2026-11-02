import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { indiaDate } from '../../time/india.js';
import { toBatch, type Batch } from './batches.js';
import { ITEMS, toItem, type Item, type ItemKind } from './items.js';

export interface StockRow {
  item: Item;
  qtyOnHand: number;
  qtyUsable: number;
  /** Batches still holding stock, first to expire first (FEFO). */
  batches: Batch[];
}

export interface StockQuery extends PageQuery {
  itemId?: string;
  kind?: ItemKind;
  q?: string;
}

/** #107: items by name with their stock: totals, and the batches that still hold any. */
export async function listStock(db: Queryable, query: StockQuery, now = new Date()): Promise<Page<StockRow>> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.itemId) where.push(`i.id = $${params.push(query.itemId)}`);
  if (query.kind) where.push(`i.kind = $${params.push(query.kind)}`);
  if (query.q) where.push(`lower(i.name) LIKE $${params.push(`%${query.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`)}`);
  const page = await pageRows(db, { select: ITEMS, where, params, orderBy: ['name', 'id'], direction: 'asc' }, query, (r) => r);

  const ids = page.items.map((r) => String(r.id));
  const { rows } = ids.length
    ? await db.query(
        `SELECT batches.*, expiry::text AS expiry_text FROM batches WHERE qty_on_hand > 0 AND item_id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})
         ORDER BY expiry, batch_no, id`,
        ids,
      )
    : { rows: [] };
  const today = indiaDate(now);
  const byItem = new Map<string, Batch[]>();
  for (const row of rows) {
    const batch = toBatch(row, today);
    byItem.set(batch.itemId, [...(byItem.get(batch.itemId) ?? []), batch]);
  }
  return {
    ...page,
    items: page.items.map((r) => {
      const batches = byItem.get(String(r.id)) ?? [];
      const qty = {
        qtyOnHand: batches.reduce((sum, b) => sum + b.qtyOnHand, 0),
        qtyUsable: batches.reduce((sum, b) => sum + b.qtyUsable, 0),
      };
      return { item: toItem(r, qty), ...qty, batches };
    }),
  };
}
