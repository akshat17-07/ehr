import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
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

export const STOCK_ALERT_KINDS = ['expiry', 'recall'] as const;
export type StockAlertKind = (typeof STOCK_ALERT_KINDS)[number];

export interface StockAlert {
  kind: StockAlertKind;
  item: Item;
  batch: Batch;
  message: string;
}

/**
 * #111: batches that need action, first to expire first. expiry: stock not set aside that expires within withinDays
 * (or already has); recall: a recalled batch with stock not yet quarantined. Low stock is #287.
 */
export async function stockAlerts(db: Queryable, query: { kind?: StockAlertKind; withinDays?: number }, now = new Date()): Promise<StockAlert[]> {
  const today = indiaDate(now);
  const until = indiaDate(new Date(indiaDayStart(today).getTime() + (query.withinDays ?? 90) * 86_400_000));
  const kinds = query.kind ? [query.kind] : STOCK_ALERT_KINDS;
  const when = [
    ...(kinds.includes('expiry') ? ['(NOT recalled AND expiry <= $1)'] : []),
    ...(kinds.includes('recall') ? ['recalled'] : []),
  ];
  const { rows } = await db.query(
    `SELECT batches.*, expiry::text AS expiry_text FROM batches WHERE qty_on_hand > qty_quarantined AND (${when.join(' OR ')})
     ORDER BY expiry, batch_no, id`,
    kinds.includes('expiry') ? [until] : [],
  );
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => String(r.item_id)))];
  const { rows: itemRows } = await db.query(`${ITEMS} WHERE i.id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids);
  const items = new Map(itemRows.map((r) => [String(r.id), r]));
  return rows.flatMap((r) => {
    const itemRow = items.get(String(r.item_id));
    if (!itemRow) return [];
    const batch = toBatch(r, today);
    const free = batch.qtyOnHand - batch.qtyQuarantined;
    const item = toItem(itemRow, { qtyOnHand: batch.qtyOnHand, qtyUsable: batch.qtyUsable });
    const kind: StockAlertKind = batch.recalled ? 'recall' : 'expiry';
    const message = batch.recalled
      ? `${item.name} batch ${batch.batchNo} is recalled: quarantine ${free} still in stock`
      : batch.expiry < today
        ? `${item.name} batch ${batch.batchNo} expired on ${batch.expiry}: quarantine ${free}`
        : `${item.name} batch ${batch.batchNo} expires on ${batch.expiry}: ${free} in stock`;
    return [{ kind, item, batch, message }];
  });
}
