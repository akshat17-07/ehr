import type { Queryable } from '../../db/migrate.js';
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
