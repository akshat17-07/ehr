import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { AppError } from '../../middleware/errors.js';
import { stockByItem, stockTotals } from './batches.js';

// Inventory items (api-list.md Item). Drugs are items too (kind drug, same id, unit from the form); the rest live
// in items. ITEMS reads both as one list.

export const ITEM_KINDS = ['drug', 'consumable', 'surgical', 'implant', 'lab_reagent', 'other'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface Item {
  id: string;
  version: number;
  name: string;
  kind: ItemKind;
  unit: string;
  packSize?: number;
  hsn?: string;
  gstRate?: number;
  mrpPaise?: number;
  active: boolean;
  qtyOnHand: number;
  qtyUsable: number;
}

/** Drugs and other items as one table, `i` (use with WHERE on i.*). */
export const ITEMS = `SELECT * FROM (
  SELECT id, version, name, 'drug' AS kind, COALESCE(form, 'unit') AS unit, NULL::integer AS pack_size, hsn, gst_rate, mrp_paise, active
  FROM drugs
  UNION ALL
  SELECT id, version, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise, active FROM items
) AS i`;

export function toItem(r: Record<string, unknown>, qty: { qtyOnHand: number; qtyUsable: number }): Item {
  return {
    id: String(r.id),
    version: Number(r.version),
    name: String(r.name),
    kind: r.kind as ItemKind,
    unit: String(r.unit),
    ...(r.pack_size != null && { packSize: Number(r.pack_size) }),
    ...(r.hsn != null && { hsn: String(r.hsn) }),
    ...(r.gst_rate != null && { gstRate: Number(r.gst_rate) }),
    ...(r.mrp_paise != null && { mrpPaise: Number(r.mrp_paise) }),
    active: r.active === true,
    ...qty,
  };
}

/** A LIKE pattern matching text anywhere in a name. */
export const nameLike = (q: string) => `%${q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;

/** #276: items by name with their stock totals. */
export async function listItems(
  db: Queryable,
  query: PageQuery & { q?: string; kind?: ItemKind; active?: boolean },
  now = new Date(),
): Promise<Page<Item>> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.kind) where.push(`i.kind = $${params.push(query.kind)}`);
  if (query.active !== undefined) where.push(`i.active = $${params.push(query.active)}`);
  if (query.q) where.push(`lower(i.name) LIKE $${params.push(nameLike(query.q))}`);
  const page = await pageRows(db, { select: ITEMS, where, params, orderBy: ['name', 'id'], direction: 'asc' }, query, (r) => r);
  const byItem = await stockByItem(db, page.items.map((r) => String(r.id)), now);
  return { ...page, items: page.items.map((r) => toItem(r, stockTotals(byItem.get(String(r.id)) ?? []))) };
}

/** Letters and digits only, lower case: "Gauze Roll, 10cm" and "gauze roll 10 cm" read the same. */
const squash = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export interface NewItem {
  name: string;
  kind: Exclude<ItemKind, 'drug'>;
  unit: string;
  packSize?: number;
  hsn?: string;
  gstRate?: number;
  mrpPaise?: number;
  /** Add even though a similar name is on file. */
  force?: boolean;
}

/**
 * #277: 409 possible_duplicate, with the matches, if an item or drug has a similar name (one name holds the other,
 * ignoring case, spaces and punctuation); resend with force to add it anyway.
 */
export async function addItem(db: Queryable, input: NewItem, by: string): Promise<Item> {
  if (!input.force) {
    const key = squash(input.name);
    const firstWord = input.name.trim().split(/\s+/)[0] ?? '';
    const { rows } = await db.query(`${ITEMS} WHERE lower(i.name) LIKE $1 ORDER BY i.name, i.id LIMIT 50`, [nameLike(firstWord)]);
    const similar = rows.filter((r) => {
      const other = squash(String(r.name));
      return other.length > 0 && key.length > 0 && (other.includes(key) || key.includes(other));
    });
    if (similar.length > 0) {
      const byItem = await stockByItem(db, similar.map((r) => String(r.id)));
      const matches = similar.map((r) => toItem(r, stockTotals(byItem.get(String(r.id)) ?? [])));
      throw new AppError(409, 'possible_duplicate', 'an item with a similar name is on file; resend with force to add it anyway', { matches });
    }
  }
  const { rows } = await db.query(
    `INSERT INTO items (id, status, created_by, updated_by, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [randomUUID(), by, input.name, input.kind, input.unit, input.packSize ?? null, input.hsn ?? null, input.gstRate ?? null, input.mrpPaise ?? null],
  );
  return toItem(rows[0] as Record<string, unknown>, { qtyOnHand: 0, qtyUsable: 0 });
}
