import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { applyStockTake, checkStockTake, type StockTake } from './batches.js';
import { ITEMS } from './items.js';

// Stock issues (api-list.md StockIssue): items used on a patient leave the store, priced at the batch MRP, and are
// always charged to the patient's bill (#116 takes in the issues not yet billed).

export interface IssueLine {
  itemId: string;
  batchId: string;
  qty: number;
  mrpPaise: number;
  gstRate: number;
  amountPaise: number;
}

export interface StockIssue extends BaseFields {
  patientId: string;
  encounterId?: string;
  admissionId?: string;
  surgeryId?: string;
  indentId?: string;
  lines: IssueLine[];
  totalPaise: number;
  billId?: string;
}

export function toStockIssue(r: Record<string, unknown>): StockIssue {
  return {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    ...(r.encounter_id != null && { encounterId: String(r.encounter_id) }),
    ...(r.admission_id != null && { admissionId: String(r.admission_id) }),
    ...(r.surgery_id != null && { surgeryId: String(r.surgery_id) }),
    ...(r.indent_id != null && { indentId: String(r.indent_id) }),
    lines: JSON.parse(String(r.lines)) as IssueLine[],
    totalPaise: Number(r.total_paise),
    ...(r.bill_id != null && { billId: String(r.bill_id) }),
  };
}

export interface NewIssue {
  patientId: string;
  encounterId?: string;
  admissionId?: string;
  surgeryId?: string;
  indentId?: string;
  lines: { itemId: string; batchId: string; qty: number }[];
}

/** A checked issue, ready to write with writeIssue. */
export interface PreparedIssue {
  input: NewIssue;
  take: StockTake;
  lines: IssueLine[];
}

/**
 * Checks an issue before any write: 404 for an unknown patient; 422 for an unknown or inactive item or a batch of
 * another item; 409 for a recalled or expired batch or short stock.
 */
export async function prepareIssue(db: Queryable, input: NewIssue, now = new Date()): Promise<PreparedIssue> {
  await getPatient(db, input.patientId, now);
  const ids = [...new Set(input.lines.map((l) => l.itemId))];
  const { rows } = await db.query(`${ITEMS} WHERE i.active AND i.id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`, ids);
  const items = new Map(rows.map((r) => [String(r.id), r]));
  const missing = input.lines.findIndex((l) => !items.has(l.itemId));
  if (missing >= 0) throw new AppError(422, 'validation_failed', `lines[${missing}].itemId: no such active item`);
  const take = await checkStockTake(db, input.lines.map((l) => ({ drugId: l.itemId, batchId: l.batchId, qty: l.qty })), now);
  const lines = input.lines.map((l) => {
    const mrpPaise = take.batches.get(l.batchId)!.mrpPaise;
    return { ...l, mrpPaise, gstRate: Number(items.get(l.itemId)!.gst_rate ?? 0), amountPaise: l.qty * mrpPaise };
  });
  return { input, take, lines };
}

/** Takes the stock out and records the issue, inside the caller's transaction. */
export async function writeIssue(tx: Queryable, { input, take, lines }: PreparedIssue, by: string): Promise<StockIssue> {
  await applyStockTake(tx, take, by);
  const { rows } = await tx.query(
    `INSERT INTO stock_issues (id, status, created_by, updated_by, patient_id, encounter_id, admission_id, surgery_id, indent_id, lines, total_paise)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      randomUUID(), by, input.patientId, input.encounterId ?? null, input.admissionId ?? null, input.surgeryId ?? null, input.indentId ?? null,
      JSON.stringify(lines), lines.reduce((sum, l) => sum + l.amountPaise, 0),
    ],
  );
  return toStockIssue(rows[0] as Record<string, unknown>);
}
