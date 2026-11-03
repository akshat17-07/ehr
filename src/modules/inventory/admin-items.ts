import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { UUID } from '../users/users.js';
import { stockByItem, stockTotals } from './batches.js';
import { ITEMS, nameLike, toItem, type Item, type ItemKind } from './items.js';

// Admin inventory items (#350-#352): list with reorder settings, edit, set reorder settings.

export interface ReorderSetting {
  itemId: string;
  version: number;
  reorderLevel?: number;
  minLevel?: number;
  reorderQty?: number;
  maxLevel?: number;
  leadTimeDays: number;
  safetyDays: number;
  preferredSupplierId?: string;
}
export type AdminItem = Item & { reorder?: ReorderSetting };

export function toReorderSetting(r: Record<string, unknown>): ReorderSetting {
  const opt = (v: unknown) => (v == null ? undefined : Number(v));
  return {
    itemId: String(r.item_id),
    version: Number(r.version),
    ...(r.reorder_level != null && { reorderLevel: opt(r.reorder_level) }),
    ...(r.min_level != null && { minLevel: opt(r.min_level) }),
    ...(r.reorder_qty != null && { reorderQty: opt(r.reorder_qty) }),
    ...(r.max_level != null && { maxLevel: opt(r.max_level) }),
    leadTimeDays: Number(r.lead_time_days),
    safetyDays: Number(r.safety_days),
    ...(r.preferred_supplier_id != null && { preferredSupplierId: String(r.preferred_supplier_id) }),
  };
}

const inList = (ids: string[], from = 1) => ids.map((_, i) => `$${from + i}`).join(', ');

async function settingsByItem(db: Queryable, ids: string[]): Promise<Map<string, ReorderSetting>> {
  const out = new Map<string, ReorderSetting>();
  if (ids.length === 0) return out;
  const { rows } = await db.query(`SELECT * FROM reorder_settings WHERE item_id IN (${inList(ids)})`, ids);
  for (const r of rows) out.set(String(r.item_id), toReorderSetting(r));
  return out;
}

/** #350: items (drugs and others) by name, with stock totals and reorder settings. */
export async function listAdminItems(
  db: Queryable,
  query: PageQuery & { q?: string; kind?: ItemKind; active?: boolean; noReorderSettings?: boolean },
  now = new Date(),
): Promise<Page<AdminItem>> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (query.kind) where.push(`i.kind = $${params.push(query.kind)}`);
  if (query.active !== undefined) where.push(`i.active = $${params.push(query.active)}`);
  if (query.q) where.push(`lower(i.name) LIKE $${params.push(nameLike(query.q))}`);
  if (query.noReorderSettings === true) where.push('NOT EXISTS (SELECT 1 FROM reorder_settings s WHERE s.item_id = i.id)');
  if (query.noReorderSettings === false) where.push('EXISTS (SELECT 1 FROM reorder_settings s WHERE s.item_id = i.id)');
  const page = await pageRows(db, { select: ITEMS, where, params, orderBy: ['name', 'id'], direction: 'asc' }, query, (r) => r);
  const ids = page.items.map((r) => String(r.id));
  const [byItem, settings] = await Promise.all([stockByItem(db, ids, now), settingsByItem(db, ids)]);
  return {
    ...page,
    items: page.items.map((r) => {
      const reorder = settings.get(String(r.id));
      return { ...toItem(r, stockTotals(byItem.get(String(r.id)) ?? [])), ...(reorder && { reorder }) };
    }),
  };
}

/** The table holding an item (a drug or another item); 404 if neither. */
async function findItem(db: Queryable, id: string): Promise<{ table: 'drugs' | 'items'; row: Record<string, unknown> }> {
  if (!UUID.test(id)) throw new AppError(404, 'not_found');
  for (const table of ['items', 'drugs'] as const) {
    const row = (await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
    if (row) return { table, row };
  }
  throw new AppError(404, 'not_found');
}

async function adminItem(db: Queryable, id: string, now = new Date()): Promise<AdminItem> {
  const { rows } = await db.query(`${ITEMS} WHERE i.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found');
  const [byItem, settings] = await Promise.all([stockByItem(db, [id], now), settingsByItem(db, [id])]);
  const reorder = settings.get(id);
  return { ...toItem(row, stockTotals(byItem.get(id) ?? [])), ...(reorder && { reorder }) };
}

export interface ItemChange {
  version: number;
  name?: string;
  unit?: string;
  packSize?: number;
  hsn?: string;
  gstRate?: number;
  mrpPaise?: number;
  active?: boolean;
  reason?: string;
}

/** #351: edits an item. 404, 409 (stale version), 422 (nothing changes, or a drug has no pack size). Returns the item and the changes made. */
export async function changeItem(
  db: Queryable,
  id: string,
  input: ItemChange,
  by: string,
): Promise<{ item: AdminItem; changes: Record<string, [unknown, unknown]> }> {
  const { table, row } = await findItem(db, id);
  if (table === 'drugs' && input.packSize !== undefined) throw new AppError(422, 'invalid_input', 'a drug has no pack size');
  // API field -> [column, current value]. A drug's unit is its form.
  const fields: Record<string, [string, unknown]> = {
    name: ['name', row.name],
    unit: [table === 'drugs' ? 'form' : 'unit', table === 'drugs' ? (row.form ?? 'unit') : row.unit],
    packSize: ['pack_size', row.pack_size == null ? undefined : Number(row.pack_size)],
    hsn: ['hsn', row.hsn ?? undefined],
    gstRate: ['gst_rate', row.gst_rate == null ? undefined : Number(row.gst_rate)],
    mrpPaise: ['mrp_paise', row.mrp_paise == null ? undefined : Number(row.mrp_paise)],
    active: ['active', row.active],
  };
  const set: Record<string, unknown> = {};
  const changes: Record<string, [unknown, unknown]> = {};
  for (const [field, [column, current]] of Object.entries(fields)) {
    const value = input[field as keyof ItemChange];
    if (value === undefined || value === current) continue;
    set[column] = value;
    changes[field] = [current ?? null, value];
  }
  if (Object.keys(set).length === 0) throw new AppError(422, 'invalid_input', 'nothing to change');
  await updateRecord(db, table, { id, version: input.version, by, set, ...(input.reason && { reason: input.reason }) });
  return { item: await adminItem(db, id), changes };
}

export interface ReorderInput {
  version?: number;
  reorderLevel?: number;
  minLevel?: number;
  reorderQty?: number;
  maxLevel?: number;
  leadTimeDays?: number;
  safetyDays?: number;
  preferredSupplierId?: string;
}

const COLUMNS = {
  reorderLevel: 'reorder_level',
  minLevel: 'min_level',
  reorderQty: 'reorder_qty',
  maxLevel: 'max_level',
  leadTimeDays: 'lead_time_days',
  safetyDays: 'safety_days',
  preferredSupplierId: 'preferred_supplier_id',
} as const;

/**
 * #352: sets the fields given (the others stay); the same values again change nothing and keep the version.
 * 404 unknown item, 409 stale version, 422 unknown supplier, no fields, or levels out of order (min <= reorder <= max).
 */
export async function setReorderSettings(
  db: Queryable,
  itemId: string,
  input: ReorderInput,
  by: string,
): Promise<{ setting: ReorderSetting; changes: Record<string, [unknown, unknown]> }> {
  await findItem(db, itemId);
  const given = (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).filter((k) => input[k] !== undefined);
  if (given.length === 0) throw new AppError(422, 'invalid_input', 'nothing to set');
  if (input.preferredSupplierId) {
    const supplier = (await db.query('SELECT id FROM suppliers WHERE id = $1', [input.preferredSupplierId])).rows[0];
    if (!supplier) throw new AppError(422, 'invalid_input', 'unknown supplier', { field: 'preferredSupplierId' });
  }

  const current = (await db.query('SELECT * FROM reorder_settings WHERE item_id = $1', [itemId])).rows[0];
  const before = current ? toReorderSetting(current) : undefined;
  if (input.version !== undefined && input.version !== before?.version) throw new AppError(409, 'conflict', 'someone else saved this record first');

  const after = { ...before, ...Object.fromEntries(given.map((k) => [k, input[k]])) } as Partial<ReorderSetting>;
  const { minLevel: lo, reorderLevel: mid, maxLevel: hi } = after;
  if ((lo !== undefined && mid !== undefined && lo > mid) || (mid !== undefined && hi !== undefined && mid > hi) || (lo !== undefined && hi !== undefined && lo > hi)) {
    throw new AppError(422, 'invalid_input', 'levels must satisfy minLevel <= reorderLevel <= maxLevel');
  }

  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of given) {
    const was = before?.[k] ?? (k === 'leadTimeDays' || k === 'safetyDays' ? 7 : null);
    if (was !== input[k]) changes[k] = [was, input[k]];
  }

  if (!current) {
    const values = given.map((k) => input[k]);
    try {
      await db.query(
        `INSERT INTO reorder_settings (id, status, created_by, updated_by, item_id${given.map((k) => `, ${COLUMNS[k]}`).join('')})
         VALUES ($1, 'active', $2, $2, $3${given.map((_, i) => `, $${i + 4}`).join('')})`,
        [randomUUID(), by, itemId, ...values],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new AppError(409, 'conflict', 'someone else saved this record first');
      throw error;
    }
  } else if (Object.keys(changes).length > 0) {
    const set = Object.fromEntries(Object.keys(changes).map((k) => [COLUMNS[k as keyof typeof COLUMNS], input[k as keyof ReorderInput]]));
    await updateRecord(db, 'reorder_settings', { id: String(current.id), version: Number(current.version), by, set });
  }
  const row = (await db.query('SELECT * FROM reorder_settings WHERE item_id = $1', [itemId])).rows[0] as Record<string, unknown>;
  return { setting: toReorderSetting(row), changes };
}

/**
 * #357: sets reorder settings for many items at once (up to 500), all or nothing. Same rules as #352 per item; a
 * failure becomes 422 naming the index (items[3]: ...). The same item twice is a 422. 409 only if someone else
 * saved the same row at the same moment.
 */
export async function setReorderSettingsBulk(
  db: Queryable,
  items: (ReorderInput & { itemId: string })[],
  by: string,
): Promise<{ settings: ReorderSetting[]; changed: number }> {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.itemId)) throw new AppError(422, 'invalid_input', 'items[' + i + ']: item given twice', { index: i });
    seen.add(item.itemId);
  });
  return withTransaction(db, async (tx) => {
    const settings: ReorderSetting[] = [];
    let changed = 0;
    for (const [i, { itemId, ...input }] of items.entries()) {
      try {
        const result = await setReorderSettings(tx, itemId, input, by);
        settings.push(result.setting);
        if (Object.keys(result.changes).length > 0) changed++;
      } catch (error) {
        if (error instanceof AppError && (error.status === 404 || error.status === 422)) {
          throw new AppError(422, 'invalid_input', 'items[' + i + ']: ' + (error.status === 404 ? 'unknown item' : error.message), { index: i });
        }
        throw error;
      }
    }
    return { settings, changed };
  });
}
