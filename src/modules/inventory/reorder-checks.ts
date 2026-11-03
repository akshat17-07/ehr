import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { getHospital } from '../reference/hospital.js';
import { UUID } from '../users/users.js';
import { toReorderSetting, type ReorderSetting } from './admin-items.js';
import { stockByItem, type Batch } from './batches.js';
import { ITEMS, toItem, type Item, type ItemKind } from './items.js';
import { SOURCES, type Line } from './movements.js';

// Reorder checks (api-list.md ReorderCheck, #287-#289): the "Check reorder" button works out what to order from the
// stock at that moment, saves it as a snapshot and sends nothing. Open purchase orders are not counted (the formula
// in api-list.md 7.12 does not use them).

export const REORDER_STATUSES = ['out_of_stock', 'below_min', 'below_reorder', 'ok'] as const;
export type ReorderStatus = (typeof REORDER_STATUSES)[number];

export interface ReorderRow {
  item: Item;
  usableQty: number;
  avgDailyUse: number;
  daysLeft?: number;
  reorderPoint: number;
  suggestedQty: number;
  expiringQty: number;
  status: ReorderStatus;
  preferredSupplierId?: string;
}

export interface CheckSettings {
  usageDays: number;
  excludeExpiringWithinDays: number;
  kind?: ItemKind;
  itemIds?: string[];
  onlyNeedingOrder: boolean;
}

export interface ReorderCheck {
  id: string;
  runBy: string;
  runAt: string;
  settings: CheckSettings;
  counts: Record<ReorderStatus, number>;
  rows?: ReorderRow[];
}

export interface CheckInput {
  kind?: ItemKind;
  itemIds?: string[];
  usageDays: number;
  excludeExpiringWithinDays: number;
  onlyNeedingOrder: boolean;
}

/** Most rows one check keeps (one transaction holds at most 3000 rows). */
const MAX_ROWS = 2500;
const DAY = 86_400_000;
const CHUNK = 400;
const inList = (ids: string[], from = 1) => ids.map((_, i) => `$${from + i}`).join(', ');

/** Net units out to patients (dispenses + issues - patient returns) per item in [start, end). */
async function usageByItem(db: Queryable, start: Date, end: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const byBatch: { batchId: string; qty: number }[] = [];
  for (const source of SOURCES.filter((s) => ['dispense', 'issue', 'patient_return'].includes(s.kind))) {
    const time = source.sql.includes('dispensed_at') ? 'dispensed_at' : 'created_at';
    const glue = source.sql.includes(' WHERE ') ? 'AND' : 'WHERE';
    const { rows } = await db.query(`${source.sql} ${glue} ${time} >= $1 AND ${time} < $2`, [start, end]);
    for (const row of rows) {
      for (const line of JSON.parse(String(row.lines)) as Line[]) {
        const qty = -source.sign * line.qty; // dispense and issue are sign -1: out is positive
        const itemId = line.itemId ?? line.drugId;
        if (itemId) out.set(itemId, (out.get(itemId) ?? 0) + qty);
        else if (line.batchId) byBatch.push({ batchId: line.batchId, qty });
      }
    }
  }
  // Patient returns keep only the batch: the item comes from the batch.
  const ids = [...new Set(byBatch.map((u) => u.batchId))];
  const items = new Map<string, string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const { rows } = await db.query(`SELECT id, item_id FROM batches WHERE id IN (${inList(part)})`, part);
    for (const r of rows) items.set(String(r.id), String(r.item_id));
  }
  for (const u of byBatch) {
    const itemId = items.get(u.batchId);
    if (itemId) out.set(itemId, (out.get(itemId) ?? 0) + u.qty);
  }
  return out;
}

async function settingsFor(db: Queryable, ids: string[]): Promise<Map<string, ReorderSetting>> {
  const out = new Map<string, ReorderSetting>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const { rows } = await db.query(`SELECT * FROM reorder_settings WHERE item_id IN (${inList(part)})`, part);
    for (const r of rows) out.set(String(r.item_id), toReorderSetting(r));
  }
  return out;
}

/**
 * #287: works out every active item (of the kind / ids given) from the stock now, saves the check and returns it.
 * Items with no settings and no use show ok with reorderPoint 0. 422 for unknown itemIds or too many rows.
 */
export async function runReorderCheck(db: Queryable, input: CheckInput, by: string, now = new Date()): Promise<ReorderCheck> {
  const itemIds = input.itemIds ? [...new Set(input.itemIds)] : undefined;
  const params: unknown[] = [];
  const where = ['i.active = true'];
  if (input.kind) where.push(`i.kind = $${params.push(input.kind)}`);
  if (itemIds) where.push(`i.id IN (${itemIds.map((id) => `$${params.push(id)}`).join(', ')})`);
  const { rows: itemRows } = await db.query(`${ITEMS} WHERE ${where.join(' AND ')} ORDER BY i.name, i.id`, params);
  if (itemIds && !input.kind) {
    const known = new Set(itemRows.map((r) => String(r.id)));
    if (itemIds.some((id) => !known.has(id))) throw new AppError(422, 'invalid_input', 'unknown or inactive item', { field: 'itemIds' });
  }

  const ids = itemRows.map((r) => String(r.id));
  const today = indiaDate(now);
  const limitDate = indiaDate(new Date(indiaDayStart(today).getTime() + input.excludeExpiringWithinDays * DAY));
  const [usage, settings] = await Promise.all([usageByItem(db, new Date(now.getTime() - input.usageDays * DAY), now), settingsFor(db, ids)]);
  const stock = new Map<string, Batch[]>();
  for (let i = 0; i < ids.length; i += CHUNK) for (const [k, v] of await stockByItem(db, ids.slice(i, i + CHUNK), now)) stock.set(k, v);

  const counts: Record<ReorderStatus, number> = { out_of_stock: 0, below_min: 0, below_reorder: 0, ok: 0 };
  const all: ReorderRow[] = itemRows.map((r) => {
    const id = String(r.id);
    const batches = stock.get(id) ?? [];
    const set = settings.get(id);
    const onHand = batches.reduce((s, b) => s + b.qtyOnHand, 0);
    // Batches expiring inside the window are still usable today but do not count towards what is available.
    const expiringQty = batches.filter((b) => b.expiry <= limitDate).reduce((s, b) => s + b.qtyUsable, 0);
    const usableQty = batches.filter((b) => b.expiry > limitDate).reduce((s, b) => s + b.qtyUsable, 0);
    const avg = Math.max(0, usage.get(id) ?? 0) / input.usageDays;
    const cover = (set?.leadTimeDays ?? 7) + (set?.safetyDays ?? 7);
    const reorderPoint = set?.reorderLevel ?? Math.ceil(avg * cover);

    let status: ReorderStatus = 'ok';
    if (set || avg > 0) {
      if (usableQty === 0) status = 'out_of_stock';
      else if (set?.minLevel !== undefined && usableQty < set.minLevel) status = 'below_min';
      else if (usableQty <= reorderPoint) status = 'below_reorder';
    }
    let suggestedQty = 0;
    if (status !== 'ok') {
      const raw = set?.reorderQty ?? (set?.maxLevel !== undefined ? set.maxLevel - usableQty : Math.ceil(avg * (cover + 30) - usableQty));
      const pack = r.pack_size != null ? Number(r.pack_size) : 1;
      suggestedQty = Math.max(0, Math.ceil(raw / pack) * pack);
    }
    counts[status]++;
    return {
      item: toItem(r, { qtyOnHand: onHand, qtyUsable: usableQty }),
      usableQty,
      avgDailyUse: Math.round(avg * 100) / 100,
      ...(avg > 0 && { daysLeft: Math.round((usableQty / avg) * 10) / 10 }),
      reorderPoint,
      suggestedQty,
      expiringQty,
      status,
      ...(set?.preferredSupplierId && { preferredSupplierId: set.preferredSupplierId }),
    };
  });
  const rows = (input.onlyNeedingOrder ? all.filter((r) => r.status !== 'ok') : all).sort(
    (a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.item.name.localeCompare(b.item.name) || a.item.id.localeCompare(b.item.id),
  );
  if (rows.length > MAX_ROWS) throw new AppError(422, 'invalid_input', `more than ${MAX_ROWS} rows: narrow with kind or itemIds`);

  const saved: CheckSettings = {
    usageDays: input.usageDays,
    excludeExpiringWithinDays: input.excludeExpiringWithinDays,
    ...(input.kind && { kind: input.kind }),
    ...(itemIds && { itemIds }),
    onlyNeedingOrder: input.onlyNeedingOrder,
  };
  const id = randomUUID();
  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO reorder_checks (id, status, created_by, updated_by, created_at, updated_at, run_at, settings, counts)
       VALUES ($1, 'active', $2, $2, $3, $3, $3, $4, $5)`,
      [id, by, now, JSON.stringify(saved), JSON.stringify(counts)],
    );
    for (let i = 0; i < rows.length; i += 100) {
      const part = rows.slice(i, i + 100);
      const values = part.map((_, n) => `(gen_random_uuid(), 'active', $1, $1, $2, $2, $3, ${i + n}, $${n + 4})`);
      await tx.query(
        `INSERT INTO reorder_check_lines (id, status, created_by, updated_by, created_at, updated_at, check_id, pos, data) VALUES ${values.join(', ')}`,
        [by, now, id, ...part.map((r) => JSON.stringify(r))],
      );
    }
  });
  return reorderCheckDetail(db, id);
}

// users.id comes from a join; the stored sub is kept when no user row has it.
const SELECT = `SELECT * FROM (SELECT c.*, u.id AS run_by_row FROM reorder_checks c LEFT JOIN users u ON u.cognito_sub = c.created_by) x`;

function toCheck(r: Record<string, unknown>): ReorderCheck {
  return {
    id: String(r.id),
    runBy: String(r.run_by_row ?? r.created_by),
    runAt: (r.run_at as Date).toISOString(),
    settings: JSON.parse(String(r.settings)) as CheckSettings,
    counts: JSON.parse(String(r.counts)) as ReorderCheck['counts'],
  };
}

/** #289: a saved check with its rows; 404 if unknown. */
export async function reorderCheckDetail(db: Queryable, id: string): Promise<ReorderCheck> {
  const row = UUID.test(id) ? (await db.query(`${SELECT} WHERE id = $1`, [id])).rows[0] : undefined;
  if (!row) throw new AppError(404, 'not_found');
  const { rows } = await db.query('SELECT data FROM reorder_check_lines WHERE check_id = $1 ORDER BY pos', [id]);
  return { ...toCheck(row), rows: rows.map((l) => JSON.parse(String(l.data)) as ReorderRow) };
}

/** #288: checks newest first, without rows. from / to are India days (inclusive) on the run time. */
export function listReorderChecks(db: Queryable, query: PageQuery & { from?: string; to?: string }): Promise<Page<ReorderCheck>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.from) where.push(`run_at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`run_at < $${params.push(new Date(indiaDayStart(query.to).getTime() + DAY))}`);
  return pageRows(db, { select: SELECT, where, params, orderBy: ['run_at', 'id'], direction: 'desc' }, query, toCheck);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => '&#' + ch.charCodeAt(0) + ';');
const KIND_NAMES: Record<string, string> = { drug: 'Drugs', consumable: 'Consumables', surgical: 'Surgical', implant: 'Implants', lab_reagent: 'Lab reagents', other: 'Other' };

/**
 * #290: the saved check's order list as one printable HTML page (A4, no scripts): items with a quantity to order,
 * grouped by preferred supplier or by kind. Every value is HTML-escaped.
 */
export async function reorderCheckHtml(db: Queryable, check: ReorderCheck, groupBy: 'supplier' | 'kind'): Promise<string> {
  const hospital = await getHospital(db);
  const toOrder = (check.rows ?? []).filter((r) => r.status !== 'ok' && r.suggestedQty > 0);
  const supplierIds = [...new Set(toOrder.flatMap((r) => (r.preferredSupplierId ? [r.preferredSupplierId] : [])))];
  const names = new Map<string, string>();
  for (let i = 0; i < supplierIds.length; i += CHUNK) {
    const part = supplierIds.slice(i, i + CHUNK);
    const { rows } = await db.query(`SELECT id, name FROM suppliers WHERE id IN (${inList(part)})`, part);
    for (const r of rows) names.set(String(r.id), String(r.name));
  }
  const groupOf = (r: ReorderRow) =>
    groupBy === 'kind'
      ? (KIND_NAMES[r.item.kind] ?? r.item.kind)
      : r.preferredSupplierId
        ? (names.get(r.preferredSupplierId) ?? 'Unknown supplier')
        : 'No preferred supplier';
  const groups = new Map<string, ReorderRow[]>();
  for (const r of toOrder) groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const when = new Date(check.runAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
  const line = (r: ReorderRow) =>
    `<tr><td>${escape(r.item.name)}</td><td>${escape(r.item.unit)}</td><td class="n">${r.usableQty}</td><td class="n">${r.reorderPoint}</td><td class="n">${r.daysLeft ?? ''}</td><td class="n">${r.suggestedQty}</td></tr>`;
  const tables = ordered
    .map(
      ([name, rows]) =>
        `<h2>${escape(name)}</h2>\n<table><thead><tr><th>Item</th><th>Unit</th><th class="n">In stock</th><th class="n">Reorder point</th><th class="n">Days left</th><th class="n">Order qty</th></tr></thead><tbody>${rows.map(line).join('')}</tbody></table>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Reorder list</title>
<style>@page{size:A4;margin:12mm}body{font:12px sans-serif;color:#000}h1,h2{margin:0}h2{font-size:15px;margin:12px 0 0}
table{width:100%;border-collapse:collapse;margin-top:6px}td,th{border:1px solid #888;padding:3px 5px;text-align:left}.n{text-align:right}</style></head><body>
<h1>${escape(hospital.name)}</h1>
<div>Reorder list (${groupBy === 'kind' ? 'by kind' : 'by supplier'}) · checked ${escape(when)}</div>
${tables || '<p>Nothing to order.</p>'}
</body></html>`;
}
