import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDayStart } from '../../time/india.js';
import { patientSummaries, type BaseFields, type PatientSummary } from '../patients/patients.js';
import { assertOpen, getEncounter } from './encounters.js';

// Orders (api-list.md Order): a lab test, imaging or procedure asked for in an encounter. `code` is the hospital's
// or the lab's own test code (free text: there is no one list). Status: ordered, resulted on the first result (#60),
// or cancelled with a reason (#61).

export const ORDER_KINDS = ['lab', 'imaging', 'procedure'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export const ORDER_STATUSES = ['ordered', 'resulted', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface Order extends Omit<BaseFields, 'status'> {
  status: OrderStatus;
  encounterId: string;
  patientId: string;
  kind: OrderKind;
  code?: string;
  name: string;
  notes?: string;
  /** Oldest first; a corrected report is another result. */
  results: Result[];
  /** In lists (#59), so the lab sees whose sample it is. */
  patient?: PatientSummary;
}

export interface Result extends BaseFields {
  orderId: string;
  value?: number;
  unit?: string;
  text?: string;
  documentId?: string;
  resultedAt: string;
}

export function toResult(r: Record<string, unknown>): Result {
  return {
    ...baseFields(r as unknown as BaseRow),
    orderId: String(r.order_id),
    ...(r.value_num != null && { value: Number(r.value_num) }),
    ...(r.unit != null && { unit: String(r.unit) }),
    ...(r.text != null && { text: String(r.text) }),
    ...(r.document_id != null && { documentId: String(r.document_id) }),
    resultedAt: (r.resulted_at as Date).toISOString(),
  };
}

/** Puts each order's results in (one query for the lot). */
async function withResults(db: Queryable, orders: Order[]): Promise<Order[]> {
  if (orders.length === 0) return orders;
  // IN ($1, $2 ...) rather than = ANY($1): DSQL has no array types.
  const list = orders.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query(
    `SELECT * FROM order_results WHERE order_id IN (${list}) AND voided_at IS NULL ORDER BY resulted_at, id`,
    orders.map((o) => o.id),
  );
  const results = rows.map(toResult);
  return orders.map((o) => ({ ...o, results: results.filter((r) => r.orderId === o.id) }));
}

export function toOrder(r: Record<string, unknown>): Order {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as OrderStatus,
    encounterId: String(r.encounter_id),
    patientId: String(r.patient_id),
    kind: r.kind as OrderKind,
    ...(r.code != null && { code: String(r.code) }),
    name: String(r.name),
    ...(r.notes != null && { notes: String(r.notes) }),
    results: [],
  };
}

export interface NewOrder {
  kind: OrderKind;
  code?: string;
  name: string;
  notes?: string;
}

/** #58: only in an open encounter. */
export async function addOrder(db: Queryable, encounterId: string, input: NewOrder, by: string): Promise<Order> {
  const encounter = await getEncounter(db, encounterId);
  assertOpen(encounter);
  const { rows } = await db.query(
    `INSERT INTO orders (id, status, created_by, updated_by, encounter_id, patient_id, kind, code, name, notes)
     VALUES ($1, 'ordered', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [randomUUID(), by, encounter.id, encounter.patientId, input.kind, input.code ?? null, input.name, input.notes ?? null],
  );
  return toOrder(rows[0] as Record<string, unknown>);
}

export interface OrderQuery extends PageQuery {
  status?: OrderStatus;
  kind?: OrderKind;
  patientId?: string;
  /** India date ordered, YYYY-MM-DD. */
  date?: string;
}

const DAY_MS = 86_400_000;

/** #59: the work list, oldest first (the order to do them in), each with the patient's summary. */
export async function listOrders(db: Queryable, query: OrderQuery, now = new Date()): Promise<Page<Order>> {
  const params: unknown[] = [];
  const where = ['voided_at IS NULL'];
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  if (query.kind) where.push(`kind = $${params.push(query.kind)}`);
  if (query.patientId) where.push(`patient_id = $${params.push(query.patientId)}`);
  if (query.date) {
    const start = indiaDayStart(query.date);
    where.push(`created_at >= $${params.push(start)}`, `created_at < $${params.push(new Date(start.getTime() + DAY_MS))}`);
  }
  const page = await pageRows(
    db,
    { select: 'SELECT * FROM orders', where, params, orderBy: ['created_at', 'id'], direction: 'asc' },
    query,
    toOrder,
  );
  const byId = await patientSummaries(db, page.items.map((o) => o.patientId), now);
  const items = await withResults(db, page.items);
  return { ...page, items: items.map((o) => ({ ...o, patient: byId.get(o.patientId) })) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One order with its results; 404 if there is none. */
export async function getOrder(db: Queryable, id: string): Promise<Order> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM orders WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such order');
  return (await withResults(db, [toOrder(rows[0] as Record<string, unknown>)]))[0] as Order;
}

export interface NewResult {
  value?: number;
  unit?: string;
  text?: string;
  resultedAt?: string;
}

/** #60: 409 on a cancelled order; the first result marks the order resulted. Also after the encounter closed. */
export async function addResult(db: Queryable, orderId: string, input: NewResult, by: string, now = new Date()): Promise<Result> {
  const order = await getOrder(db, orderId);
  if (order.status === 'cancelled') throw new AppError(409, 'cancelled', 'this order was cancelled');
  const resultedAt = input.resultedAt ? new Date(input.resultedAt) : now;
  if (resultedAt.getTime() > now.getTime() + 5 * 60_000) throw new AppError(422, 'invalid_input', 'resultedAt: this time has not come yet');
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO order_results (id, status, created_by, updated_by, order_id, patient_id, value_num, unit, text, resulted_at)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [randomUUID(), by, order.id, order.patientId, input.value ?? null, input.unit ?? null, input.text ?? null, resultedAt],
    );
    if (order.status === 'ordered') {
      await updateRecord(tx, 'orders', { id: order.id, version: order.version, by, set: { status: 'resulted' } });
    }
    return toResult(rows[0] as Record<string, unknown>);
  });
}
