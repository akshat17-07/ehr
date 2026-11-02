import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';
import { batchesByIds } from './batches.js';

// Quarantine (api-list.md Quarantine): stock set aside, still on the books but not usable. This is not a removal:
// it leaves only by a supplier return (#281) or a write-off.

export const QUARANTINE_REASONS = ['expired', 'damaged', 'recalled', 'other'] as const;
export type QuarantineReason = (typeof QUARANTINE_REASONS)[number];

export interface Quarantine extends BaseFields {
  batchId: string;
  itemId: string;
  qty: number;
  reason: QuarantineReason;
  note?: string;
  recallId?: string;
}

export function toQuarantine(r: Record<string, unknown>): Quarantine {
  return {
    ...baseFields(r as unknown as BaseRow),
    batchId: String(r.batch_id),
    itemId: String(r.item_id),
    qty: Number(r.qty),
    reason: r.reason as QuarantineReason,
    ...(r.note != null && { note: String(r.note) }),
    ...(r.recall_id != null && { recallId: String(r.recall_id) }),
  };
}

export interface NewQuarantine {
  batchId: string;
  qty: number;
  reason: QuarantineReason;
  note?: string;
}

/** Sets stock aside inside the caller's transaction (also used by recalls). */
export async function addQuarantine(
  tx: Queryable,
  batch: { id: string; version: number; itemId: string; qtyQuarantined: number },
  input: NewQuarantine & { recallId?: string },
  by: string,
  extra: Record<string, unknown> = {},
): Promise<Quarantine> {
  await updateRecord(tx, 'batches', { id: batch.id, version: batch.version, by, set: { qty_quarantined: batch.qtyQuarantined + input.qty, ...extra } });
  const { rows } = await tx.query(
    `INSERT INTO quarantines (id, status, created_by, updated_by, batch_id, item_id, qty, reason, note, recall_id)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [randomUUID(), by, batch.id, batch.itemId, input.qty, input.reason, input.note ?? null, input.recallId ?? null],
  );
  return toQuarantine(rows[0] as Record<string, unknown>);
}

/** #110: 404 for an unknown batch; 409 if the batch has less than qty not yet quarantined. */
export async function quarantineStock(db: Queryable, input: NewQuarantine, by: string, now = new Date()): Promise<Quarantine> {
  const batch = (await batchesByIds(db, [input.batchId], now)).get(input.batchId);
  if (!batch) throw new AppError(404, 'not_found', 'no such batch');
  const free = batch.qtyOnHand - batch.qtyQuarantined;
  if (input.qty > free) throw new AppError(409, 'short_stock', `batch ${batch.batchNo} has ${free} not yet quarantined`);
  return withTransaction(db, (tx) => addQuarantine(tx, batch, input, by));
}
