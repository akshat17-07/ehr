import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';
import { batchesByIds } from './batches.js';

// Stock counts (api-list.md StockCount): staff count the shelves; each batch's book quantity is kept beside what
// was found. The books are not corrected here: Admin/Head Doctor look at the differences (#304).

export interface CountLine {
  batchId: string;
  bookQty: number;
  countedQty: number;
  /** counted − book: below 0 is missing stock. */
  difference: number;
}

export interface StockCount extends BaseFields {
  countedBy: string;
  at: string;
  lines: CountLine[];
  note?: string;
}

export function toStockCount(r: Record<string, unknown>): StockCount {
  const base = baseFields(r as unknown as BaseRow);
  return {
    ...base,
    countedBy: base.createdBy,
    at: base.createdAt,
    lines: JSON.parse(String(r.lines)) as CountLine[],
    ...(r.note != null && { note: String(r.note) }),
  };
}

/** #280: 422 for an unknown batch or one counted twice. */
export async function recordCount(db: Queryable, input: { lines: { batchId: string; countedQty: number }[]; note?: string }, by: string): Promise<StockCount> {
  const ids = input.lines.map((l) => l.batchId);
  if (new Set(ids).size !== ids.length) throw new AppError(422, 'validation_failed', 'lines: a batch is listed twice');
  const batches = await batchesByIds(db, ids);
  const lines = input.lines.map((l, i) => {
    const batch = batches.get(l.batchId);
    if (!batch) throw new AppError(422, 'validation_failed', `lines[${i}].batchId: no such batch`);
    return { batchId: l.batchId, bookQty: batch.qtyOnHand, countedQty: l.countedQty, difference: l.countedQty - batch.qtyOnHand };
  });
  const { rows } = await db.query(
    `INSERT INTO stock_counts (id, status, created_by, updated_by, lines, note) VALUES ($1, 'active', $2, $2, $3, $4) RETURNING *`,
    [randomUUID(), by, JSON.stringify(lines), input.note ?? null],
  );
  return toStockCount(rows[0] as Record<string, unknown>);
}
