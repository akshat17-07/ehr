import { z } from 'zod';
import { AppError } from '../middleware/errors.js';
import type { Queryable } from './migrate.js';

// Lists (api-list.md Page<T>): query `limit` (1–100, default 50) and `cursor`; reply `{ items, nextCursor? }`.
// Keyset paging: the cursor holds the sort values of the last row sent, so the next page starts right after it.
// Unlike OFFSET it stays fast on big tables and never skips or repeats a row when new rows are added.

/** Parses `limit` and `cursor` from the query string (use `.extend()` to add a list's own filters). */
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});
export type PageQuery = z.infer<typeof pageQuery>;

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface PageSpec {
  /** `SELECT ... FROM ...`, without WHERE, ORDER BY or LIMIT. */
  select: string;
  /** Filters, joined with AND. Use $1, $2 ... for `params`. */
  where?: string[];
  params?: unknown[];
  /** Sort columns; the last one must be unique (usually `id`) so ties still have one order. */
  orderBy: string[];
  /** Newest first is the usual list order. */
  direction?: 'asc' | 'desc';
}

const COLUMN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

export function encodeCursor(values: string[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor: string, size: number): string[] {
  try {
    const values: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(values) && values.length === size && values.every((v) => typeof v === 'string')) return values;
  } catch {
    // falls through to the error below
  }
  throw new AppError(422, 'invalid_input', 'bad cursor');
}

/** The value a cursor keeps for a column: dates as ISO text, everything else as text. */
function keyValue(row: Record<string, unknown>, column: string): string {
  const value = row[column.split('.').pop() as string];
  if (value === null || value === undefined) throw new Error(`Sort column ${column} is empty; sort columns must be NOT NULL`);
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Runs one page of a list query. `map` turns a database row into the API shape. */
export async function pageRows<T>(
  db: Queryable,
  spec: PageSpec,
  { limit, cursor }: PageQuery,
  map: (row: Record<string, unknown>) => T,
): Promise<Page<T>> {
  const { orderBy, direction = 'desc' } = spec;
  if (orderBy.length === 0 || !orderBy.every((c) => COLUMN.test(c))) throw new Error(`Bad orderBy: ${orderBy.join(', ')}`);

  const where = [...(spec.where ?? [])];
  const params = [...(spec.params ?? [])];
  if (cursor) {
    // (a, b) after (x, y) is: a > x OR (a = x AND b > y), written out because not every database compares row values.
    const after = decodeCursor(cursor, orderBy.length);
    const op = direction === 'desc' ? '<' : '>';
    const first = params.length + 1;
    params.push(...after);
    const ors = orderBy.map((column, i) =>
      [...orderBy.slice(0, i).map((c, j) => `${c} = $${first + j}`), `${column} ${op} $${first + i}`].join(' AND '),
    );
    where.push(`(${ors.map((o) => `(${o})`).join(' OR ')})`);
  }

  const sql = [
    spec.select,
    where.length ? `WHERE ${where.join(' AND ')}` : '',
    `ORDER BY ${orderBy.map((c) => `${c} ${direction.toUpperCase()}`).join(', ')}`,
    `LIMIT ${limit + 1}`, // one extra row says whether there is a next page
  ]
    .filter(Boolean)
    .join(' ');
  const { rows } = await db.query(sql, params);

  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(map),
    ...(rows.length > limit && last && { nextCursor: encodeCursor(orderBy.map((c) => keyValue(last, c))) }),
  };
}
