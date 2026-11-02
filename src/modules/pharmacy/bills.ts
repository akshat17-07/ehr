import { randomUUID } from 'node:crypto';
import { nextCount } from '../../db/counters.js';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { applyStockTake, batchesByIds, checkStockTake, type StockTake } from '../inventory/batches.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { getDispense } from './dispenses.js';
import type { Setting } from './queue.js';

// Pharmacy bills (api-list.md PharmacyBill). Medicines sell at the batch MRP, which includes GST; the GST inside is
// worked out per line for the invoice. OPD bills are GST tax invoices with a number; IPD ones go on the ward bill.

export interface PharmacyBillLine {
  drugId: string;
  batchId: string;
  qty: number;
  mrpPaise: number;
  gstRate: number;
  amountPaise: number;
}

export interface PharmacyBill extends BaseFields {
  patientId: string;
  dispenseId?: string;
  setting: Setting;
  number?: string;
  lines: PharmacyBillLine[];
  totalPaise: number;
  /** The GST included in the total. */
  gstPaise: number;
  paidPaise: number;
}

export function toPharmacyBill(r: Record<string, unknown>): PharmacyBill {
  return {
    ...baseFields(r as unknown as BaseRow),
    patientId: String(r.patient_id),
    ...(r.dispense_id != null && { dispenseId: String(r.dispense_id) }),
    setting: r.setting as Setting,
    ...(r.number != null && { number: String(r.number) }),
    lines: JSON.parse(String(r.lines)) as PharmacyBillLine[],
    totalPaise: Number(r.total_paise),
    gstPaise: Number(r.gst_paise),
    paidPaise: Number(r.paid_paise),
  };
}

/** The Indian financial year (April to March) of an IST date, e.g. 26-27. */
export function financialYear(date: string): string {
  const year = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** GST inside an MRP-inclusive amount. */
const gstInside = (amountPaise: number, rate: number) => Math.round((amountPaise * rate) / (100 + rate));

export interface NewPharmacyBill {
  patientId: string;
  dispenseId?: string;
  setting: Setting;
  lines?: { drugId: string; batchId: string; qty: number }[];
}

/**
 * #104: from a dispense (its lines, less returns), or a counter sale of OTC medicines (lines given; the stock leaves
 * the batches here). 409 if the dispense is already billed; 422 for another patient's dispense, lines with a dispense,
 * no lines without one, or a prescription drug sold over the counter.
 */
export async function createPharmacyBill(db: Queryable, input: NewPharmacyBill, by: string, now = new Date()): Promise<PharmacyBill> {
  const patient = await getPatient(db, input.patientId, now);
  let items: { drugId: string; batchId: string; qty: number }[];
  let stock: StockTake | undefined;
  if (input.dispenseId) {
    if (input.lines) throw new AppError(422, 'validation_failed', 'lines: taken from the dispense, not given');
    const given = await getDispense(db, input.dispenseId);
    if (given.patientId !== patient.id) throw new AppError(422, 'validation_failed', "dispenseId: another patient's dispense");
    const { rows } = await db.query('SELECT id FROM pharmacy_bills WHERE dispense_id = $1 AND voided_at IS NULL', [given.id]);
    if (rows[0]) throw new AppError(409, 'already_billed', 'this dispense is already billed');
    items = given.lines.map((l) => ({ drugId: l.drugId, batchId: l.batchId, qty: l.qty - (l.returnedQty ?? 0) })).filter((l) => l.qty > 0);
  } else {
    if (!input.lines?.length) throw new AppError(422, 'validation_failed', 'lines: needed without a dispense');
    items = input.lines;
  }

  const drugIds = [...new Set(items.map((l) => l.drugId))];
  const { rows: drugRows } = drugIds.length
    ? await db.query(`SELECT id, schedule, gst_rate FROM drugs WHERE id IN (${drugIds.map((_, i) => `$${i + 1}`).join(', ')})`, drugIds)
    : { rows: [] };
  const drugs = new Map(drugRows.map((d) => [String(d.id), { schedule: String(d.schedule), gstRate: Number(d.gst_rate ?? 0) }]));
  items.forEach((line, i) => {
    const drug = drugs.get(line.drugId);
    if (!drug) throw new AppError(422, 'validation_failed', `lines[${i}].drugId: no such drug`);
    if (!input.dispenseId && drug.schedule !== 'OTC') {
      throw new AppError(422, 'prescription_needed', `lines[${i}]: a Schedule ${drug.schedule} drug is sold only against a prescription`);
    }
  });
  if (!input.dispenseId) stock = await checkStockTake(db, items, now);
  const batches = stock?.batches ?? (await batchesByIds(db, items.map((l) => l.batchId), now));

  const lines: PharmacyBillLine[] = items.map((l) => {
    const mrpPaise = batches.get(l.batchId)!.mrpPaise;
    return { ...l, mrpPaise, gstRate: drugs.get(l.drugId)!.gstRate, amountPaise: l.qty * mrpPaise };
  });
  const totalPaise = lines.reduce((sum, l) => sum + l.amountPaise, 0);
  const gstPaise = lines.reduce((sum, l) => sum + gstInside(l.amountPaise, l.gstRate), 0);

  let number: string | null = null;
  if (input.setting === 'opd') {
    // Taken outside the transaction (db/counters.ts); a failed bill leaves a gap, never a repeat.
    const { rows } = await db.query('SELECT invoice_prefix FROM hospital LIMIT 1');
    const year = financialYear(indiaDate(now));
    number = `${String(rows[0]?.invoice_prefix ?? 'INV')}/PH/${year}/${await nextCount(db, `pharmacy-invoice-${year}`)}`;
  }

  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO pharmacy_bills (id, status, created_by, updated_by, patient_id, dispense_id, setting, number, lines, total_paise, gst_paise)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [randomUUID(), by, patient.id, input.dispenseId ?? null, input.setting, number, JSON.stringify(lines), totalPaise, gstPaise],
    );
    if (stock) await applyStockTake(tx, stock, by);
    return toPharmacyBill(rows[0] as Record<string, unknown>);
  });
}

/** #105: bills newest first; date is one IST day. */
export async function listPharmacyBills(db: Queryable, query: PageQuery & { date?: string; patientId?: string }): Promise<Page<PharmacyBill>> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.patientId) where.push(`patient_id = $${params.push(query.patientId)}`);
  if (query.date) {
    const start = indiaDayStart(query.date);
    where.push(`created_at >= $${params.push(start)}`, `created_at < $${params.push(new Date(start.getTime() + 86_400_000))}`);
  }
  return pageRows(db, { select: 'SELECT * FROM pharmacy_bills', where, params, orderBy: ['created_at', 'id'] }, query, toPharmacyBill);
}
