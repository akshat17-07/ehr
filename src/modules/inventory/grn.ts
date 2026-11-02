import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import type { BaseFields } from '../patients/patients.js';
import { indiaDate } from '../../time/india.js';
import { ITEMS } from './items.js';

// Goods received (api-list.md Grn): a supplier's invoice comes in and its lines go into batches. A batch number
// already on file for the item gets the stock added (its expiry and MRP must match); a new one becomes a batch.

export interface GrnLine {
  itemId: string;
  batchNo: string;
  /** YYYY-MM-DD */
  expiry: string;
  qty: number;
  freeQty?: number;
  costPaise: number;
  mrpPaise: number;
  /** The batch the line went into. */
  batchId?: string;
}

export interface Grn extends BaseFields {
  supplierId: string;
  purchaseOrderId?: string;
  invoiceNo: string;
  invoiceDate: string;
  lines: GrnLine[];
  receivedBy: string;
}

export function toGrn(r: Record<string, unknown>): Grn {
  return {
    ...baseFields(r as unknown as BaseRow),
    supplierId: String(r.supplier_id),
    ...(r.purchase_order_id != null && { purchaseOrderId: String(r.purchase_order_id) }),
    invoiceNo: String(r.invoice_no),
    invoiceDate: String(r.invoice_date_text),
    lines: JSON.parse(String(r.lines)) as GrnLine[],
    receivedBy: String(r.received_by),
  };
}

const invalid = (message: string) => new AppError(422, 'validation_failed', message);
const list = (n: number) => Array.from({ length: n }, (_, i) => `$${i + 1}`).join(', ');

export interface NewGrn {
  supplierId: string;
  purchaseOrderId?: string;
  invoiceNo: string;
  invoiceDate: string;
  lines: Omit<GrnLine, 'batchId'>[];
}

/**
 * #108: stock comes in. 422 for an unknown or inactive supplier or item, an expired batch, an MRP above the NPPA
 * ceiling or below the cost, or a batch on file with another expiry or MRP; 409 if this supplier invoice is in.
 */
export async function receiveGoods(db: Queryable, input: NewGrn, by: string, now = new Date()): Promise<Grn> {
  const today = indiaDate(now);
  if (input.invoiceDate > today) throw invalid('invoiceDate: not in the future');
  const { rows: suppliers } = await db.query('SELECT active FROM suppliers WHERE id = $1', [input.supplierId]);
  if (suppliers[0]?.active !== true) throw invalid('supplierId: no such active supplier');
  const { rows: same } = await db.query('SELECT id FROM grns WHERE supplier_id = $1 AND invoice_no = $2', [input.supplierId, input.invoiceNo]);
  if (same[0]) throw new AppError(409, 'duplicate_invoice', 'this supplier invoice is already received');

  const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
  const { rows: itemRows } = await db.query(`${ITEMS} WHERE i.id IN (${list(itemIds.length)})`, itemIds);
  const items = new Map(itemRows.map((r) => [String(r.id), r]));
  const { rows: ceilingRows } = await db.query(`SELECT id, ceiling_paise FROM drugs WHERE ceiling_paise IS NOT NULL AND id IN (${list(itemIds.length)})`, itemIds);
  const ceilings = new Map(ceilingRows.map((r) => [String(r.id), Number(r.ceiling_paise)]));
  input.lines.forEach((line, i) => {
    if (items.get(line.itemId)?.active !== true) throw invalid(`lines[${i}].itemId: no such active item`);
    if (line.expiry < today) throw invalid(`lines[${i}].expiry: the batch has already expired`);
    const ceiling = ceilings.get(line.itemId);
    if (ceiling !== undefined && line.mrpPaise > ceiling) throw invalid(`lines[${i}].mrpPaise: above the NPPA ceiling of ${ceiling} paise`);
    if (line.costPaise > line.mrpPaise) throw invalid(`lines[${i}].costPaise: above the MRP`);
  });

  // Batches on file for these item + batch numbers.
  const keys = input.lines.flatMap((l) => [l.itemId, l.batchNo]);
  const { rows: batchRows } = await db.query(
    `SELECT id, version, item_id, batch_no, expiry::text AS expiry_text, mrp_paise, qty_on_hand FROM batches
     WHERE ${input.lines.map((_, i) => `(item_id = $${2 * i + 1} AND batch_no = $${2 * i + 2})`).join(' OR ')}`,
    keys,
  );
  const onFile = new Map(batchRows.map((r) => [`${r.item_id}|${r.batch_no}`, r]));
  // Lines of one batch are added up, so each batch is written once; they must agree on expiry and MRP.
  const totals = new Map<string, { first: NewGrn['lines'][number]; qty: number }>();
  input.lines.forEach((line, i) => {
    const key = `${line.itemId}|${line.batchNo}`;
    const batch = onFile.get(key);
    if (batch && (batch.expiry_text !== line.expiry || Number(batch.mrp_paise) !== line.mrpPaise)) {
      throw invalid(`lines[${i}]: batch ${line.batchNo} is on file with expiry ${batch.expiry_text} and MRP ${batch.mrp_paise} paise`);
    }
    const total = totals.get(key);
    if (total && (total.first.expiry !== line.expiry || total.first.mrpPaise !== line.mrpPaise)) {
      throw invalid(`lines[${i}]: batch ${line.batchNo} is given twice with another expiry or MRP`);
    }
    totals.set(key, { first: total?.first ?? line, qty: (total?.qty ?? 0) + line.qty + (line.freeQty ?? 0) });
  });

  return withTransaction(db, async (tx) => {
    const batchIds = new Map<string, string>();
    for (const [key, { first, qty }] of totals) {
      const batch = onFile.get(key);
      if (batch) {
        batchIds.set(key, String(batch.id));
        await updateRecord(tx, 'batches', { id: String(batch.id), version: Number(batch.version), by, set: { qty_on_hand: Number(batch.qty_on_hand) + qty } });
      } else {
        const id = randomUUID();
        batchIds.set(key, id);
        await tx.query(
          `INSERT INTO batches (id, status, created_by, updated_by, item_id, batch_no, expiry, supplier_id, cost_paise, mrp_paise, qty_on_hand)
           VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [id, by, first.itemId, first.batchNo, first.expiry, input.supplierId, first.costPaise, first.mrpPaise, qty],
        );
      }
    }
    const lines: GrnLine[] = input.lines.map((l) => ({ ...l, batchId: batchIds.get(`${l.itemId}|${l.batchNo}`)! }));
    const { rows } = await tx.query(
      `INSERT INTO grns (id, status, created_by, updated_by, supplier_id, purchase_order_id, invoice_no, invoice_date, lines, received_by)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $2) RETURNING *, invoice_date::text AS invoice_date_text`,
      [randomUUID(), by, input.supplierId, input.purchaseOrderId ?? null, input.invoiceNo, input.invoiceDate, JSON.stringify(lines)],
    );
    return toGrn(rows[0] as Record<string, unknown>);
  });
}
