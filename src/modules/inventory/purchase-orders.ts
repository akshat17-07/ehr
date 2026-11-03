import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { UUID } from '../users/users.js';
import { nextCount } from '../../db/counters.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { financialYear } from '../pharmacy/bills.js';
import { getHospital, type Address } from '../reference/hospital.js';
import { ITEMS } from './items.js';
import { reorderCheckDetail } from './reorder-checks.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from '../patients/patients.js';

// Purchase orders (api-list.md PurchaseOrder): Admin/Head Doctor make and place them (#295-#301); the store
// receives goods against the open ones (#108).

export const PO_STATUSES = ['draft', 'placed', 'part_received', 'received', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];
/** Orders still waiting for goods. */
export const OPEN_PO_STATUSES = ['placed', 'part_received'] as const;

export interface PurchaseOrder extends Omit<BaseFields, 'status'> {
  status: PoStatus;
  number?: string;
  supplierId: string;
  supplierName?: string;
  reorderCheckId?: string;
  lines: { itemId: string; qty: number; ratePaise?: number }[];
  note?: string;
  placedAt?: string;
  /** Received so far, by item id. */
  receivedQty: Record<string, number>;
}

export function toPurchaseOrder(r: Record<string, unknown>): PurchaseOrder {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as PoStatus,
    ...(r.number != null && { number: String(r.number) }),
    supplierId: String(r.supplier_id),
    ...(r.supplier_name != null && { supplierName: String(r.supplier_name) }),
    ...(r.reorder_check_id != null && { reorderCheckId: String(r.reorder_check_id) }),
    lines: JSON.parse(String(r.lines)) as PurchaseOrder['lines'],
    ...(r.note != null && { note: String(r.note) }),
    ...(r.placed_at != null && { placedAt: (r.placed_at as Date).toISOString() }),
    receivedQty: JSON.parse(String(r.received_qty)) as Record<string, number>,
  };
}

/** #283: open orders (placed or part received), oldest placed first. */
export async function openPurchaseOrders(
  db: Queryable,
  query: { status?: (typeof OPEN_PO_STATUSES)[number]; supplierId?: string },
): Promise<PurchaseOrder[]> {
  const statuses = query.status ? [query.status] : OPEN_PO_STATUSES;
  const params: unknown[] = [...statuses];
  const where = [`status IN (${statuses.map((_, i) => `$${i + 1}`).join(', ')})`, 'voided_at IS NULL'];
  if (query.supplierId) where.push(`supplier_id = $${params.push(query.supplierId)}`);
  const { rows } = await db.query(`SELECT * FROM purchase_orders WHERE ${where.join(' AND ')} ORDER BY placed_at, id LIMIT 500`, params);
  return rows.map(toPurchaseOrder);
}

export type PoLine = PurchaseOrder['lines'][number];

// The supplier's name comes from a join; the wrapper lets paging name plain columns.
const SELECT = 'SELECT * FROM (SELECT p.*, s.name AS supplier_name FROM purchase_orders p LEFT JOIN suppliers s ON s.id = p.supplier_id) x';
const DAY = 86_400_000;
const MAX_LINES = 500;

/** 422 unless the lines are 1..500, with known items, each item once. */
async function checkLines(db: Queryable, lines: PoLine[]): Promise<void> {
  if (lines.length === 0) throw new AppError(422, 'invalid_input', 'a purchase order needs at least one line', { field: 'lines' });
  if (lines.length > MAX_LINES) throw new AppError(422, 'invalid_input', `at most ${MAX_LINES} lines`, { field: 'lines' });
  const ids = lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw new AppError(422, 'invalid_input', 'an item is on two lines', { field: 'lines' });
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const holders = part.map((_, n) => `$${n + 1}`).join(', ');
    const { rows } = await db.query(`SELECT id FROM drugs WHERE id IN (${holders}) UNION ALL SELECT id FROM items WHERE id IN (${holders})`, part);
    for (const r of rows) known.add(String(r.id));
  }
  if (ids.some((id) => !known.has(id))) throw new AppError(422, 'invalid_input', 'unknown item', { field: 'lines' });
}

export interface NewPurchaseOrder {
  supplierId: string;
  reorderCheckId?: string;
  lines?: PoLine[];
  note?: string;
}

/**
 * #295: a draft order. With a reorderCheckId and no lines, the check's suggested quantities for items whose preferred
 * supplier is this one are used. 422 for an unknown supplier, check or item, or when no lines end up.
 */
export async function createPurchaseOrder(db: Queryable, input: NewPurchaseOrder, by: string): Promise<PurchaseOrder> {
  const supplier = (await db.query('SELECT id, active FROM suppliers WHERE id = $1', [input.supplierId])).rows[0];
  if (!supplier || supplier.active === false) throw new AppError(422, 'invalid_input', 'unknown supplier', { field: 'supplierId' });
  let lines = input.lines;
  if (input.reorderCheckId) {
    const check = await reorderCheckDetail(db, input.reorderCheckId).catch((error: unknown) => {
      if (error instanceof AppError && error.status === 404) throw new AppError(422, 'invalid_input', 'unknown reorder check', { field: 'reorderCheckId' });
      throw error;
    });
    lines ??= (check.rows ?? [])
      .filter((r) => r.status !== 'ok' && r.suggestedQty > 0 && r.preferredSupplierId === input.supplierId)
      .map((r) => ({ itemId: r.item.id, qty: r.suggestedQty }));
  }
  if (!lines || lines.length === 0) throw new AppError(422, 'invalid_input', 'no lines to order', { field: 'lines' });
  await checkLines(db, lines);
  const id = randomUUID();
  await db.query(
    `INSERT INTO purchase_orders (id, status, created_by, updated_by, supplier_id, reorder_check_id, lines, note)
     VALUES ($1, 'draft', $2, $2, $3, $4, $5, $6)`,
    [id, by, input.supplierId, input.reorderCheckId ?? null, JSON.stringify(lines), input.note ?? null],
  );
  return purchaseOrderDetail(db, id);
}

/** #297: one order with its supplier's name; 404 if unknown. */
export async function purchaseOrderDetail(db: Queryable, id: string): Promise<PurchaseOrder> {
  const row = UUID.test(id) ? (await db.query(`${SELECT} WHERE id = $1 AND voided_at IS NULL`, [id])).rows[0] : undefined;
  if (!row) throw new AppError(404, 'not_found', 'no such purchase order');
  return toPurchaseOrder(row);
}

/** #296: newest first; from / to are India days (inclusive) on the day it was made. */
export function listPurchaseOrders(
  db: Queryable,
  query: PageQuery & { status?: PoStatus; supplierId?: string; from?: string; to?: string },
): Promise<Page<PurchaseOrder>> {
  const where = ['voided_at IS NULL'];
  const params: unknown[] = [];
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  if (query.supplierId) where.push(`supplier_id = $${params.push(query.supplierId)}`);
  if (query.from) where.push(`created_at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`created_at < $${params.push(new Date(indiaDayStart(query.to).getTime() + DAY))}`);
  return pageRows(db, { select: SELECT, where, params, orderBy: ['created_at', 'id'], direction: 'desc' }, query, toPurchaseOrder);
}

/** #298: draft only (409 not_draft); the new lines replace the old ones; the old version is kept. */
export async function changePurchaseOrder(
  db: Queryable,
  id: string,
  input: { version: number; lines?: PoLine[]; note?: string | null },
  by: string,
): Promise<PurchaseOrder> {
  const current = await purchaseOrderDetail(db, id);
  if (current.status !== 'draft') throw new AppError(409, 'not_draft', 'only a draft purchase order can be changed');
  const set: Record<string, unknown> = {};
  if (input.lines !== undefined) {
    await checkLines(db, input.lines);
    set.lines = JSON.stringify(input.lines);
  }
  if (input.note !== undefined) set.note = input.note;
  if (Object.keys(set).length === 0) throw new AppError(422, 'invalid_input', 'nothing to change');
  await updateRecord(db, 'purchase_orders', { id, version: input.version, by, set });
  return purchaseOrderDetail(db, id);
}

/** #299: draft -> placed with the next human number (PO/<financial year>/<n>). 409 not_draft; 422 without lines. */
export async function placePurchaseOrder(db: Queryable, id: string, version: number, by: string, now = new Date()): Promise<PurchaseOrder> {
  const current = await purchaseOrderDetail(db, id);
  if (current.status !== 'draft') throw new AppError(409, 'not_draft', 'only a draft purchase order can be placed');
  if (current.lines.length === 0) throw new AppError(422, 'invalid_input', 'a purchase order needs at least one line', { field: 'lines' });
  if (current.version !== version) throw new AppError(409, 'stale_version', 'this purchase order was changed by someone else');
  // Taken outside the transaction (db/counters.ts): a failed save leaves a gap, never a repeat.
  const year = financialYear(indiaDate(now));
  const number = `PO/${year}/${await nextCount(db, `purchase-order-${year}`)}`;
  await updateRecord(db, 'purchase_orders', { id, version, by, set: { status: 'placed', number, placed_at: now } });
  return purchaseOrderDetail(db, id);
}

/**
 * #300: draft or placed -> cancelled, the reason kept in the history. 409 already_cancelled, or
 * goods_received once anything (or all) has been received.
 */
export async function cancelPurchaseOrder(db: Queryable, id: string, reason: string, by: string): Promise<PurchaseOrder> {
  const current = await purchaseOrderDetail(db, id);
  if (current.status === 'cancelled') throw new AppError(409, 'already_cancelled', 'this purchase order is already cancelled');
  const received = Object.values(current.receivedQty).some((q) => q > 0);
  if (current.status === 'received' || current.status === 'part_received' || received) {
    throw new AppError(409, 'goods_received', 'goods have been received against this purchase order');
  }
  await updateRecord(db, 'purchase_orders', { id, version: current.version, by, reason, set: { status: 'cancelled' } });
  return purchaseOrderDetail(db, id);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;
const addressText = (a?: Address) => (a ? [a.line1, a.line2, a.city, a.district, a.state, a.pincode].filter(Boolean).join(', ') : '');

/**
 * #301: the order as one printable HTML page (A4, no scripts). 409 not_placed for a draft or a cancelled order.
 * Every value is HTML-escaped.
 */
export async function purchaseOrderHtml(db: Queryable, order: PurchaseOrder): Promise<string> {
  if (order.status === 'draft' || order.status === 'cancelled') {
    throw new AppError(409, 'not_placed', 'only a placed purchase order can be printed');
  }
  const hospital = await getHospital(db);
  const supplier = (await db.query('SELECT * FROM suppliers WHERE id = $1', [order.supplierId])).rows[0];
  const ids = order.lines.map((l) => l.itemId);
  const items = new Map<string, { name: string; unit: string }>();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const { rows } = await db.query(`${ITEMS} WHERE id IN (${part.map((_, n) => `$${n + 1}`).join(', ')})`, part);
    for (const r of rows) items.set(String(r.id), { name: String(r.name), unit: String(r.unit) });
  }
  const placed = order.placedAt ? new Date(order.placedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }) : '';
  let total = 0;
  const lines = order.lines
    .map((l, n) => {
      const item = items.get(l.itemId);
      const amount = l.ratePaise === undefined ? undefined : l.ratePaise * l.qty;
      total += amount ?? 0;
      const rate = l.ratePaise === undefined ? '' : rupees(l.ratePaise);
      return (
        `<tr><td class="n">${n + 1}</td><td>${escape(item?.name ?? l.itemId)}</td><td>${escape(item?.unit ?? '')}</td><td class="n">${l.qty}</td>` +
        `<td class="n">${rate}</td><td class="n">${amount === undefined ? '' : rupees(amount)}</td></tr>`
      );
    })
    .join('');
  const supplierName = String(supplier?.name ?? order.supplierName ?? '');
  const supplierGstin = supplier?.gstin != null ? ` · GSTIN ${escape(String(supplier.gstin))}` : '';
  const supplierAddress = supplier?.address != null ? addressText(JSON.parse(String(supplier.address)) as Address) : '';
  const hospitalGstin = hospital.gstin ? ` · GSTIN ${escape(hospital.gstin)}` : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(order.number ?? 'Purchase order')}</title>
<style>@page{size:A4;margin:12mm}body{font:12px sans-serif;color:#000}h1,h2{margin:0}h2{font-size:15px;margin:10px 0 0}
table{width:100%;border-collapse:collapse;margin-top:6px}td,th{border:1px solid #888;padding:3px 5px;text-align:left}.n{text-align:right}</style></head><body>
<h1>${escape(hospital.name)}</h1>
<div>${escape(addressText(hospital.address))}${hospitalGstin}</div>
<h2>Purchase order ${escape(order.number ?? '')}</h2>
<div>Date: ${escape(placed)}</div>
<div>To: ${escape(supplierName)}${supplierGstin}</div>
${supplierAddress ? `<div>${escape(supplierAddress)}</div>` : ''}
<table><thead><tr><th class="n">#</th><th>Item</th><th>Unit</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody>${lines}</tbody></table>
${total > 0 ? `<p class="n"><b>Total (before tax): ${rupees(total)}</b></p>` : ''}
${order.note ? `<p>Note: ${escape(order.note)}</p>` : ''}
</body></html>`;
}
