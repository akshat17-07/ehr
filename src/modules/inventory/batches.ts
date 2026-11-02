import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import { UUID } from '../users/users.js';

// Stock batches (api-list.md Batch). Quantities change only through stock movements (GRN, dispense, quarantine…);
// quarantined stock stays on hand but can't be used. A batch can be used up to and on its expiry date.

export interface Batch {
  id: string;
  version: number;
  itemId: string;
  batchNo: string;
  /** YYYY-MM-DD */
  expiry: string;
  supplierId?: string;
  costPaise: number;
  mrpPaise: number;
  qtyOnHand: number;
  qtyQuarantined: number;
  /** On hand − quarantined, and 0 if expired or recalled. */
  qtyUsable: number;
  recalled: boolean;
}

export function toBatch(r: Record<string, unknown>, today: string): Batch {
  const expiry = String(r.expiry_text);
  const onHand = Number(r.qty_on_hand);
  const quarantined = Number(r.qty_quarantined);
  const recalled = r.recalled === true;
  const batch: Batch = {
    id: String(r.id),
    version: Number(r.version),
    itemId: String(r.item_id),
    batchNo: String(r.batch_no),
    expiry,
    costPaise: Number(r.cost_paise),
    mrpPaise: Number(r.mrp_paise),
    qtyOnHand: onHand,
    qtyQuarantined: quarantined,
    qtyUsable: recalled || expiry < today ? 0 : Math.max(0, onHand - quarantined),
    recalled,
  };
  if (r.supplier_id != null) batch.supplierId = String(r.supplier_id);
  return batch;
}

/** #13: a drug's batches, first to expire first (FEFO). `inStock` keeps only batches with usable stock. 404 for an unknown drug. */
export async function listDrugBatches(db: Queryable, drugId: string, filter: { inStock?: boolean } = {}, now = new Date()): Promise<Batch[]> {
  const drug = UUID.test(drugId) ? (await db.query('SELECT id FROM drugs WHERE id = $1', [drugId])).rows[0] : undefined;
  if (!drug) throw new AppError(404, 'not_found');

  const today = indiaDate(now);
  const { rows } = await db.query(
    // The date as text, so no time zone can move it a day.
    'SELECT batches.*, expiry::text AS expiry_text FROM batches WHERE item_id = $1 ORDER BY expiry, batch_no, id',
    [drugId],
  );
  const batches = rows.map((r) => toBatch(r, today));
  return filter.inStock === undefined ? batches : batches.filter((b) => b.qtyUsable > 0 === filter.inStock);
}

/** Batches by id (any order), with the raw rows' versions for updates; unknown ids are left out. */
export async function batchesByIds(db: Queryable, ids: string[], now = new Date()): Promise<Map<string, Batch>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT batches.*, expiry::text AS expiry_text FROM batches WHERE id IN (${unique.map((_, i) => `$${i + 1}`).join(', ')})`,
    unique,
  );
  const today = indiaDate(now);
  return new Map(rows.map((r) => [String(r.id), toBatch(r, today)]));
}

/** Stock to take out: the batches read, and how much leaves each one. */
export interface StockTake {
  batches: Map<string, Batch>;
  taking: Map<string, number>;
}

/**
 * Checks lines taken from batches: each batch must be of the line's drug (422), not recalled or expired (409), and
 * hold enough usable stock for all the lines that take from it (409 short_stock).
 */
export async function checkStockTake(db: Queryable, lines: { drugId: string; batchId: string; qty: number }[], now = new Date()): Promise<StockTake> {
  const batches = await batchesByIds(db, lines.map((l) => l.batchId), now);
  const today = indiaDate(now);
  const taking = new Map<string, number>();
  lines.forEach((line, i) => {
    const batch = batches.get(line.batchId);
    if (!batch || batch.itemId !== line.drugId) throw new AppError(422, 'validation_failed', `lines[${i}].batchId: not a batch of this drug`);
    if (batch.recalled) throw new AppError(409, 'recalled', `batch ${batch.batchNo} is recalled`);
    if (batch.expiry < today) throw new AppError(409, 'expired', `batch ${batch.batchNo} expired on ${batch.expiry}`);
    taking.set(batch.id, (taking.get(batch.id) ?? 0) + line.qty);
  });
  for (const [id, qty] of taking) {
    const batch = batches.get(id)!;
    if (qty > batch.qtyUsable) throw new AppError(409, 'short_stock', `batch ${batch.batchNo} has ${batch.qtyUsable} usable, ${qty} asked`);
  }
  return { batches, taking };
}

/** Takes checked stock out of its batches (inside the caller's transaction); a batch changed meanwhile gives 409. */
export async function applyStockTake(tx: Queryable, { batches, taking }: StockTake, by: string): Promise<void> {
  for (const [id, qty] of taking) {
    const batch = batches.get(id)!;
    await updateRecord(tx, 'batches', { id, version: batch.version, by, set: { qty_on_hand: batch.qtyOnHand - qty } });
  }
}
