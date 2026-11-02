import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';
import { batchesByIds } from './batches.js';

// Supplier returns (api-list.md SupplierReturn): expired, damaged, recalled or excess stock goes back to the
// supplier. It leaves the books; stock set aside (quarantined) goes first, since that is usually why it goes back.

export const SUPPLIER_RETURN_REASONS = ['expired', 'damaged', 'recalled', 'excess', 'wrong_item'] as const;
export const SUPPLIER_REFUND_MODES = ['credit_note', 'bank', 'cash'] as const;

export interface SupplierReturn extends BaseFields {
  supplierId: string;
  /** amountPaise: qty at the batch's cost. */
  lines: { batchId: string; qty: number; amountPaise: number }[];
  reason: (typeof SUPPLIER_RETURN_REASONS)[number];
  creditNoteNo?: string;
  refundPaise: number;
  refundMode?: (typeof SUPPLIER_REFUND_MODES)[number];
}

export function toSupplierReturn(r: Record<string, unknown>): SupplierReturn {
  return {
    ...baseFields(r as unknown as BaseRow),
    supplierId: String(r.supplier_id),
    lines: JSON.parse(String(r.lines)) as SupplierReturn['lines'],
    reason: r.reason as SupplierReturn['reason'],
    ...(r.credit_note_no != null && { creditNoteNo: String(r.credit_note_no) }),
    refundPaise: Number(r.refund_paise),
    ...(r.refund_mode != null && { refundMode: r.refund_mode as SupplierReturn['refundMode'] }),
  };
}

export type NewSupplierReturn = Omit<SupplierReturn, keyof BaseFields | 'lines'> & { lines: { batchId: string; qty: number }[] };

/** #281: 422 for an unknown supplier, an unknown batch or one listed twice; 409 short_stock for more than is on hand. */
export async function returnToSupplier(db: Queryable, input: NewSupplierReturn, by: string): Promise<SupplierReturn> {
  const { rows: suppliers } = await db.query('SELECT id FROM suppliers WHERE id = $1', [input.supplierId]);
  if (!suppliers[0]) throw new AppError(422, 'validation_failed', 'supplierId: no such supplier');
  const ids = input.lines.map((l) => l.batchId);
  if (new Set(ids).size !== ids.length) throw new AppError(422, 'validation_failed', 'lines: a batch is listed twice');
  const batches = await batchesByIds(db, ids);
  const lines = input.lines.map((l, i) => {
    const batch = batches.get(l.batchId);
    if (!batch) throw new AppError(422, 'validation_failed', `lines[${i}].batchId: no such batch`);
    if (l.qty > batch.qtyOnHand) throw new AppError(409, 'short_stock', `batch ${batch.batchNo} has ${batch.qtyOnHand} on hand`);
    return { batchId: l.batchId, qty: l.qty, amountPaise: l.qty * batch.costPaise };
  });
  return withTransaction(db, async (tx) => {
    for (const line of lines) {
      const batch = batches.get(line.batchId)!;
      await updateRecord(tx, 'batches', {
        id: batch.id,
        version: batch.version,
        by,
        set: { qty_on_hand: batch.qtyOnHand - line.qty, qty_quarantined: Math.max(0, batch.qtyQuarantined - line.qty) },
      });
    }
    const { rows } = await tx.query(
      `INSERT INTO supplier_returns (id, status, created_by, updated_by, supplier_id, lines, reason, credit_note_no, refund_paise, refund_mode)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [randomUUID(), by, input.supplierId, JSON.stringify(lines), input.reason, input.creditNoteNo ?? null, input.refundPaise, input.refundMode ?? null],
    );
    return toSupplierReturn(rows[0] as Record<string, unknown>);
  });
}
