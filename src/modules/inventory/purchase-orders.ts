import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDayStart } from '../../time/india.js';
import { UUID } from '../users/users.js';
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
