import type { Queryable } from '../../db/migrate.js';
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
