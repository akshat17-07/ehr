import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import type { BaseFields } from '../patients/patients.js';
import { toBatch } from './batches.js';
import { ITEMS } from './items.js';
import { addQuarantine } from './quarantine.js';

// Recalls (api-list.md Recall): the batches named are marked recalled and all their stock still free is quarantined.
// Batch numbers the hospital never received are kept on the recall but change nothing.

export interface Recall extends BaseFields {
  itemId: string;
  batchNos: string[];
  reference: string;
  note?: string;
  /** The batches on file that were recalled, and how much was quarantined now. */
  batches: { batchId: string; batchNo: string; qtyQuarantined: number }[];
}

export function toRecall(r: Record<string, unknown>): Recall {
  return {
    ...baseFields(r as unknown as BaseRow),
    itemId: String(r.item_id),
    batchNos: JSON.parse(String(r.batch_nos)) as string[],
    reference: String(r.reference),
    ...(r.note != null && { note: String(r.note) }),
    batches: JSON.parse(String(r.batches)) as Recall['batches'],
  };
}

/** #112: 422 for an unknown item. */
export async function recallBatches(
  db: Queryable,
  input: { itemId: string; batchNos: string[]; reference: string; note?: string },
  by: string,
  now = new Date(),
): Promise<Recall> {
  const { rows: items } = await db.query(`${ITEMS} WHERE i.id = $1`, [input.itemId]);
  if (!items[0]) throw new AppError(422, 'validation_failed', 'itemId: no such item');
  const batchNos = [...new Set(input.batchNos)];
  const { rows } = await db.query(
    `SELECT batches.*, expiry::text AS expiry_text FROM batches WHERE item_id = $1 AND batch_no IN (${batchNos.map((_, i) => `$${i + 2}`).join(', ')})
     ORDER BY batch_no`,
    [input.itemId, ...batchNos],
  );
  const today = indiaDate(now);
  const id = randomUUID();
  return withTransaction(db, async (tx) => {
    const batches: Recall['batches'] = [];
    for (const row of rows) {
      const batch = toBatch(row, today);
      const free = batch.qtyOnHand - batch.qtyQuarantined;
      if (free > 0) {
        await addQuarantine(tx, batch, { batchId: batch.id, qty: free, reason: 'recalled', note: input.reference, recallId: id }, by, { recalled: true });
      } else if (!batch.recalled) {
        await updateRecord(tx, 'batches', { id: batch.id, version: batch.version, by, set: { recalled: true } });
      }
      batches.push({ batchId: batch.id, batchNo: batch.batchNo, qtyQuarantined: Math.max(0, free) });
    }
    const { rows: inserted } = await tx.query(
      `INSERT INTO recalls (id, status, created_by, updated_by, item_id, batch_nos, reference, note, batches)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, by, input.itemId, JSON.stringify(batchNos), input.reference, input.note ?? null, JSON.stringify(batches)],
    );
    return toRecall(inserted[0] as Record<string, unknown>);
  });
}
