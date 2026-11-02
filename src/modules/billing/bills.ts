import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { ITEMS } from '../inventory/items.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { gstInside } from '../pharmacy/bills.js';

// Patient bills (api-list.md Bill). Prices are as charged, GST included (services are GST-exempt, goods are at MRP);
// the GST inside is worked out per line. A bill with any taxed line is a tax invoice, else a bill of supply.
// A new bill also takes in what the patient was charged elsewhere and not yet billed: items issued to them (#278,
// #279) and their IPD pharmacy bills (#104).

export const BILL_SERIES = ['tax_invoice', 'bill_of_supply'] as const;
export type BillSeries = (typeof BILL_SERIES)[number];
export const BILL_STATUSES = ['draft', 'final', 'paid', 'part_paid', 'void'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export interface BillLine {
  tariffId?: string;
  text: string;
  qty: number;
  unitPaise: number;
  discountPaise: number;
  gstRate: number;
  amountPaise: number;
  /** Taken in from a stock issue or an IPD pharmacy bill. */
  source?: { kind: 'stock_issue' | 'pharmacy_bill'; id: string };
}

export interface Bill extends Omit<BaseFields, 'status'> {
  status: BillStatus;
  patientId: string;
  encounterId?: string;
  admissionId?: string;
  series: BillSeries;
  number?: string;
  lines: BillLine[];
  subtotalPaise: number;
  gstPaise: number;
  discountPaise: number;
  totalPaise: number;
  paidPaise: number;
  duePaise: number;
  finalisedAt?: string;
}

export function toBill(r: Record<string, unknown>): Bill {
  const totalPaise = Number(r.total_paise);
  const paidPaise = Number(r.paid_paise);
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as BillStatus,
    patientId: String(r.patient_id),
    ...(r.encounter_id != null && { encounterId: String(r.encounter_id) }),
    ...(r.admission_id != null && { admissionId: String(r.admission_id) }),
    series: r.series as BillSeries,
    ...(r.number != null && { number: String(r.number) }),
    lines: JSON.parse(String(r.lines)) as BillLine[],
    subtotalPaise: Number(r.subtotal_paise),
    gstPaise: Number(r.gst_paise),
    discountPaise: Number(r.discount_paise),
    totalPaise,
    paidPaise,
    duePaise: totalPaise - paidPaise,
    ...(r.finalised_at != null && { finalisedAt: (r.finalised_at as Date).toISOString() }),
  };
}

/** The money columns of a bill from its lines, and any bill-level discount. */
export function billTotals(lines: BillLine[], billDiscountPaise = 0) {
  const subtotalPaise = lines.reduce((sum, l) => sum + l.qty * l.unitPaise, 0);
  const discountPaise = lines.reduce((sum, l) => sum + l.discountPaise, 0) + billDiscountPaise;
  return {
    series: (lines.some((l) => l.gstRate > 0) ? 'tax_invoice' : 'bill_of_supply') as BillSeries,
    subtotal_paise: subtotalPaise,
    gst_paise: lines.reduce((sum, l) => sum + gstInside(l.amountPaise, l.gstRate), 0),
    discount_paise: discountPaise,
    total_paise: subtotalPaise - discountPaise,
  };
}

export type LineInput = { tariffId?: string; text?: string; qty: number; unitPaise?: number };

const invalid = (message: string) => new AppError(422, 'validation_failed', message);

/** Lines as typed: a tariff gives the name, price and GST in force today; a free line needs its text and price. */
export async function pricedLines(db: Queryable, input: LineInput[], now = new Date()): Promise<BillLine[]> {
  const ids = [...new Set(input.flatMap((l) => (l.tariffId ? [l.tariffId] : [])))];
  const { rows } = ids.length
    ? await db.query(
        `SELECT id, name_en, price_paise, gst_rate FROM tariffs WHERE valid_from <= $1 AND (valid_to IS NULL OR valid_to >= $1)
         AND id IN (${ids.map((_, i) => `$${i + 2}`).join(', ')})`,
        [indiaDate(now), ...ids],
      )
    : { rows: [] };
  const tariffs = new Map(rows.map((r) => [String(r.id), r]));
  return input.map((l, i) => {
    if (l.tariffId) {
      const tariff = tariffs.get(l.tariffId);
      if (!tariff) throw invalid(`lines[${i}].tariffId: no such price in force`);
      if (l.unitPaise !== undefined) throw invalid(`lines[${i}].unitPaise: the tariff sets the price; give a discount instead`);
      const unitPaise = Number(tariff.price_paise);
      const line: BillLine = { tariffId: l.tariffId, text: l.text ?? String(tariff.name_en), qty: l.qty, unitPaise, discountPaise: 0, gstRate: Number(tariff.gst_rate), amountPaise: l.qty * unitPaise };
      return line;
    }
    if (!l.text || l.unitPaise === undefined) throw invalid(`lines[${i}]: text and unitPaise are needed without a tariffId`);
    return { text: l.text, qty: l.qty, unitPaise: l.unitPaise, discountPaise: 0, gstRate: 0, amountPaise: l.qty * l.unitPaise };
  });
}

/** What the patient was charged elsewhere and not yet billed, as bill lines, and the records to mark billed. */
async function unbilled(db: Queryable, patientId: string) {
  const { rows: issues } = await db.query('SELECT id, version, lines FROM stock_issues WHERE patient_id = $1 AND bill_id IS NULL AND voided_at IS NULL ORDER BY created_at, id', [patientId]);
  const { rows: pharmacy } = await db.query(
    `SELECT id, version, lines FROM pharmacy_bills WHERE patient_id = $1 AND setting = 'ipd' AND bill_id IS NULL AND voided_at IS NULL ORDER BY created_at, id`,
    [patientId],
  );
  type Stored = { itemId?: string; drugId?: string; batchId: string; qty: number; mrpPaise: number; gstRate: number; amountPaise: number };
  const sources = [
    ...issues.map((r) => ({ kind: 'stock_issue' as const, table: 'stock_issues', row: r })),
    ...pharmacy.map((r) => ({ kind: 'pharmacy_bill' as const, table: 'pharmacy_bills', row: r })),
  ].map((s) => ({ ...s, lines: JSON.parse(String(s.row.lines)) as Stored[] }));
  const itemIds = [...new Set(sources.flatMap((s) => s.lines.map((l) => l.itemId ?? l.drugId ?? '')))];
  const batchIds = [...new Set(sources.flatMap((s) => s.lines.map((l) => l.batchId)))];
  const names = new Map<string, string>();
  const batchNos = new Map<string, string>();
  if (itemIds.length) {
    const { rows } = await db.query(`${ITEMS} WHERE i.id IN (${itemIds.map((_, i) => `$${i + 1}`).join(', ')})`, itemIds);
    for (const r of rows) names.set(String(r.id), String(r.name));
    const { rows: batches } = await db.query(`SELECT id, batch_no FROM batches WHERE id IN (${batchIds.map((_, i) => `$${i + 1}`).join(', ')})`, batchIds);
    for (const b of batches) batchNos.set(String(b.id), String(b.batch_no));
  }
  const lines: BillLine[] = sources.flatMap((s) =>
    s.lines.map((l) => ({
      text: `${names.get(l.itemId ?? l.drugId ?? '') ?? 'Item'} (batch ${batchNos.get(l.batchId) ?? '?'})`,
      qty: l.qty,
      unitPaise: l.mrpPaise,
      discountPaise: 0,
      gstRate: l.gstRate,
      amountPaise: l.amountPaise,
      source: { kind: s.kind, id: String(s.row.id) },
    })),
  );
  return { lines, records: sources.map((s) => ({ table: s.table, id: String(s.row.id), version: Number(s.row.version) })) };
}

/** The visit and admission a bill is for must be the patient's (422). */
export async function assertLinks(db: Queryable, patientId: string, links: { encounterId?: string; admissionId?: string }) {
  for (const [field, table] of [['encounterId', 'encounters'], ['admissionId', 'admissions']] as const) {
    const id = links[field];
    if (!id) continue;
    const { rows } = await db.query(`SELECT patient_id FROM ${table} WHERE id = $1`, [id]);
    if (rows[0]?.patient_id !== patientId) throw invalid(`${field}: not this patient's`);
  }
}

/** #116: a draft bill. 404 for an unknown patient; 422 for a bad line, a link that isn't the patient's, or nothing to bill. */
export async function createBill(
  db: Queryable,
  input: { patientId: string; encounterId?: string; admissionId?: string; lines: LineInput[] },
  by: string,
  now = new Date(),
): Promise<Bill> {
  await getPatient(db, input.patientId, now);
  await assertLinks(db, input.patientId, input);
  const typed = await pricedLines(db, input.lines, now);
  const taken = await unbilled(db, input.patientId);
  const lines = [...typed, ...taken.lines];
  if (lines.length === 0) throw invalid('lines: nothing to bill');
  const id = randomUUID();
  const totals = billTotals(lines);
  return withTransaction(db, async (tx) => {
    for (const record of taken.records) await updateRecord(tx, record.table, { id: record.id, version: record.version, by, set: { bill_id: id } });
    const { rows } = await tx.query(
      `INSERT INTO bills (id, status, created_by, updated_by, patient_id, encounter_id, admission_id, series, lines, subtotal_paise, gst_paise, discount_paise, total_paise)
       VALUES ($1, 'draft', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        id, by, input.patientId, input.encounterId ?? null, input.admissionId ?? null, totals.series, JSON.stringify(lines),
        totals.subtotal_paise, totals.gst_paise, totals.discount_paise, totals.total_paise,
      ],
    );
    return toBill(rows[0] as Record<string, unknown>);
  });
}

export interface BillQuery extends PageQuery {
  patientId?: string;
  /** One IST day; or from/to, both IST days, inclusive. */
  date?: string;
  from?: string;
  to?: string;
  status?: BillStatus;
  number?: string;
}

/** #117: bills newest first. */
export async function listBills(db: Queryable, query: BillQuery): Promise<Page<Bill>> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.patientId) where.push(`patient_id = $${params.push(query.patientId)}`);
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  if (query.number) where.push(`number = $${params.push(query.number)}`);
  const from = query.date ?? query.from;
  const to = query.date ?? query.to;
  if (from) where.push(`created_at >= $${params.push(indiaDayStart(from))}`);
  if (to) where.push(`created_at < $${params.push(new Date(indiaDayStart(to).getTime() + 86_400_000))}`);
  return pageRows(db, { select: 'SELECT * FROM bills', where, params, orderBy: ['created_at', 'id'] }, query, toBill);
}
