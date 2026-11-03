import type { Queryable } from '../../db/migrate.js';
import { decodeCursor, encodeCursor, type Page, type PageQuery } from '../../db/page.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';

// Stock movements (api-list.md StockMovement): every change to a batch, read back from the records that made it.
// Nothing is kept twice. qty is + for stock in and − for stock out; for quarantine and release it is the change in
// usable stock (the stock stays on hand).

export const MOVEMENT_KINDS = ['grn', 'dispense', 'patient_return', 'issue', 'supplier_return', 'quarantine', 'release'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export interface StockMovement {
  at: string;
  itemId: string;
  batchId: string;
  kind: MovementKind;
  qty: number;
  /** The record that moved the stock: a GRN, dispense, pharmacy return, counter bill, issue, supplier return or quarantine. */
  ref: string;
  by: string;
}

export interface MovementQuery extends PageQuery {
  itemId?: string;
  batchId?: string;
  kind?: MovementKind;
  from?: string;
  to?: string;
}

export type Line = { itemId?: string; drugId?: string; batchId?: string; qty: number; freeQty?: number };

/** Where each kind is read from, and how a stored line becomes a signed quantity. */
export const SOURCES: { kind: MovementKind; sql: string; sign: 1 | -1; qty?: (l: Line) => number }[] = [
  { kind: 'grn', sql: 'SELECT id, created_at AS at, created_by AS by, lines FROM grns', sign: 1, qty: (l) => l.qty + (l.freeQty ?? 0) },
  { kind: 'dispense', sql: 'SELECT id, dispensed_at AS at, created_by AS by, lines FROM dispenses', sign: -1 },
  // Counter sales: the stock left with the bill (#104 without a dispense).
  { kind: 'dispense', sql: 'SELECT id, created_at AS at, created_by AS by, lines FROM pharmacy_bills WHERE dispense_id IS NULL', sign: -1 },
  { kind: 'patient_return', sql: 'SELECT id, created_at AS at, created_by AS by, lines FROM pharmacy_returns', sign: 1 },
  { kind: 'issue', sql: 'SELECT id, created_at AS at, created_by AS by, lines FROM stock_issues', sign: -1 },
  { kind: 'supplier_return', sql: 'SELECT id, created_at AS at, created_by AS by, lines FROM supplier_returns', sign: -1 },
  {
    kind: 'quarantine',
    sql: `SELECT id, created_at AS at, created_by AS by, '[{"batchId":"' || batch_id || '","qty":' || qty || '}]' AS lines FROM quarantines`,
    sign: -1,
  },
];

/** The longest period one list covers; the default is the last 30 days. */
const MAX_DAYS = 366;

/** #282: newest first. 422 if to is before from, or the period is over a year. */
export async function listMovements(db: Queryable, query: MovementQuery, now = new Date()): Promise<Page<StockMovement>> {
  const to = query.to ?? indiaDate(now);
  const end = new Date(indiaDayStart(to).getTime() + 86_400_000);
  const start = query.from ? indiaDayStart(query.from) : new Date(end.getTime() - 30 * 86_400_000);
  if (end <= start) throw new AppError(422, 'validation_failed', 'to: before from');
  if (end.getTime() - start.getTime() > MAX_DAYS * 86_400_000) throw new AppError(422, 'validation_failed', `to: at most ${MAX_DAYS} days after from`);

  const keyed: { key: string; movement: StockMovement }[] = [];
  for (const source of SOURCES.filter((s) => !query.kind || s.kind === query.kind)) {
    const time = source.sql.includes('dispensed_at') ? 'dispensed_at' : 'created_at';
    const glue = source.sql.includes(' WHERE ') ? 'AND' : 'WHERE';
    const { rows } = await db.query(`${source.sql} ${glue} ${time} >= $1 AND ${time} < $2`, [start, end]);
    for (const row of rows) {
      const at = (row.at as Date).toISOString();
      (JSON.parse(String(row.lines)) as Line[]).forEach((line, n) => {
        if (!line.batchId) return;
        keyed.push({
          key: `${at}|${source.kind}|${String(row.id)}|${String(n).padStart(4, '0')}`,
          movement: {
            at,
            itemId: line.itemId ?? line.drugId ?? '',
            batchId: line.batchId,
            kind: source.kind,
            qty: source.sign * (source.qty ?? ((l: Line) => l.qty))(line),
            ref: String(row.id),
            by: String(row.by),
          },
        });
      });
    }
  }

  // Patient returns and quarantines keep only the batch: the item comes from the batch.
  const unknown = [...new Set(keyed.filter((k) => !k.movement.itemId).map((k) => k.movement.batchId))];
  if (unknown.length > 0) {
    const { rows } = await db.query(`SELECT id, item_id FROM batches WHERE id IN (${unknown.map((_, i) => `$${i + 1}`).join(', ')})`, unknown);
    const items = new Map(rows.map((r) => [String(r.id), String(r.item_id)]));
    for (const k of keyed) if (!k.movement.itemId) k.movement.itemId = items.get(k.movement.batchId) ?? '';
  }

  const after = query.cursor ? decodeCursor(query.cursor, 1)[0]! : undefined;
  const wanted = keyed
    .filter(({ movement: m }) => (!query.itemId || m.itemId === query.itemId) && (!query.batchId || m.batchId === query.batchId))
    .filter(({ key }) => after === undefined || key < after)
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  const page = wanted.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((k) => k.movement),
    ...(wanted.length > query.limit && last && { nextCursor: encodeCursor([last.key]) }),
  };
}
