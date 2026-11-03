import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';

// The hospital's price list (api-list.md Tariff). Prices are never changed in place: POST /admin/tariffs (#192) adds
// a new list version from a date, and the old rows get valid_to the day before, so old bills keep their prices.

export const TARIFF_SETTINGS = ['opd', 'ipd', 'both'] as const;
export type TariffSetting = (typeof TARIFF_SETTINGS)[number];

export interface Tariff {
  id: string;
  version: number;
  code: string;
  nameEn: string;
  nameHi?: string;
  departmentId?: string;
  pricePaise: number;
  /** Percent. */
  gstRate: number;
  sacCode?: string;
  setting: TariffSetting;
  /** YYYY-MM-DD */
  validFrom: string;
  validTo?: string;
}

// Dates as text, so no time zone can move them a day.
const SELECT = 'SELECT tariffs.*, valid_from::text AS valid_from_text, valid_to::text AS valid_to_text FROM tariffs';

const opt = (v: unknown) => (v == null ? undefined : String(v));

function toTariff(r: Record<string, unknown>): Tariff {
  const tariff: Tariff = {
    id: String(r.id),
    version: Number(r.version),
    code: String(r.code),
    nameEn: String(r.name_en),
    nameHi: opt(r.name_hi),
    departmentId: opt(r.department_id),
    pricePaise: Number(r.price_paise),
    gstRate: Number(r.gst_rate),
    sacCode: opt(r.sac_code),
    setting: r.setting as TariffSetting,
    validFrom: String(r.valid_from_text),
    validTo: opt(r.valid_to_text),
  };
  for (const key of Object.keys(tariff) as (keyof Tariff)[]) if (tariff[key] === undefined) delete tariff[key];
  return tariff;
}

export interface TariffFilter {
  departmentId?: string;
  /** opd or ipd: also gives the items for both. */
  setting?: 'opd' | 'ipd';
  /** Part of the code or English or Hindi name. */
  q?: string;
  /** YYYY-MM-DD; default today in India. */
  on?: string;
}

/** #10: the prices in force on a date, A to Z. */
export async function listTariffs(db: Queryable, filter: TariffFilter = {}): Promise<Tariff[]> {
  const params: unknown[] = [filter.on ?? indiaDate()];
  const where = ['valid_from <= $1', '(valid_to IS NULL OR valid_to >= $1)'];
  const add = (sql: (n: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  if (filter.departmentId) add((n) => `department_id = ${n}`, filter.departmentId);
  if (filter.setting) add((n) => `setting IN (${n}, 'both')`, filter.setting);
  if (filter.q) {
    const like = `%${filter.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    add((n) => `(lower(code) LIKE ${n} OR lower(name_en) LIKE ${n} OR name_hi LIKE ${n})`, like);
  }
  const { rows } = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY name_en, id`, params);
  return rows.map(toTariff);
}

export interface RateBoardRow {
  nameEn?: string;
  nameHi?: string;
  pricePaise: number;
}

/**
 * #11: today's prices for the price board shown at the hospital,
 * in Hindi and English. A row with no Hindi name shows the English one in Hindi.
 */
export async function rateBoardRows(db: Queryable, lang: 'en' | 'hi' | 'both'): Promise<RateBoardRow[]> {
  const tariffs = await listTariffs(db);
  return tariffs.map((t) => ({
    ...(lang !== 'hi' && { nameEn: t.nameEn }),
    ...(lang !== 'en' && { nameHi: t.nameHi ?? t.nameEn }),
    pricePaise: t.pricePaise,
  }));
}

export interface NewTariffItem {
  code: string;
  nameEn: string;
  nameHi?: string;
  departmentId?: string;
  pricePaise: number;
  gstRate: number;
  sacCode?: string;
  setting: TariffSetting;
}

const oneDayBefore = (date: string) => new Date(new Date(`${date}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

/**
 * #192: a new price list from `validFrom` (today or later). Each item is the price of its code from that date: the
 * code's price in force then (if any) ends the day before and is kept for old bills; codes not in `items` go on as
 * they were, so a slip can't drop a price. 422 for a past date, a repeated code or an unknown department; 409
 * price_conflict if `validFrom` is not after the current list's start. All or nothing.
 */
export async function addTariffList(
  db: Queryable,
  input: { validFrom: string; items: NewTariffItem[] },
  by: string,
  now = new Date(),
): Promise<{ version: number; count: number }> {
  const invalid = (message: string) => new AppError(422, 'invalid_input', message);
  if (input.validFrom < indiaDate(now)) throw invalid('validFrom: a new price list starts today or later');
  const codes = input.items.map((i) => i.code);
  if (new Set(codes).size !== codes.length) throw invalid('items: each code once');
  const departments = [...new Set(input.items.flatMap((i) => (i.departmentId ? [i.departmentId] : [])))];
  for (const id of departments) {
    const { rows } = await db.query('SELECT 1 FROM departments WHERE id = $1', [id]);
    if (!rows[0]) throw invalid(`departmentId ${id}: no such department`);
  }
  return withTransaction(db, async (tx) => {
    const { rows: head } = await tx.query('SELECT COALESCE(MAX(list_version), 0) AS v, MAX(valid_from)::text AS latest FROM tariffs');
    const latest = opt(head[0]?.latest);
    if (latest && input.validFrom <= latest) {
      throw new AppError(409, 'price_conflict', `The current price list starts ${latest}; a new list must start after that`);
    }
    const version = Number(head[0]?.v) + 1;
    // Rows written: 1 end-dated old row + 1 new row per item = at most 2000 for 1000 items, under the 3000-row cap.
    // (updateRecord is not used for the old rows: its history row would make it 3 per item = 3000.)
    const { rows: current } = await tx.query(
      `SELECT id FROM tariffs WHERE valid_to IS NULL AND code IN (${codes.map((_, n) => `$${n + 1}`).join(', ')})`,
      codes,
    );
    for (const old of current) {
      await tx.query('UPDATE tariffs SET valid_to = $2, version = version + 1, updated_at = now(), updated_by = $3 WHERE id = $1', [
        old.id, oneDayBefore(input.validFrom), by,
      ]);
    }
    for (const item of input.items) {
      await tx.query(
        `INSERT INTO tariffs (id, status, created_by, updated_by, list_version, code, name_en, name_hi, department_id, price_paise, gst_rate, sac_code, setting, valid_from)
         VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [randomUUID(), by, version, item.code, item.nameEn, item.nameHi ?? null, item.departmentId ?? null, item.pricePaise, item.gstRate, item.sacCode ?? null, item.setting, input.validFrom],
      );
    }
    return { version, count: input.items.length };
  });
}
