import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate, indiaDayStart } from '../../time/india.js';
import { DEFAULT_DISCOUNT_LIMIT_PAISE } from '../billing/discounts.js';
import { DEFAULT_REFUND_LIMIT_PAISE } from '../billing/refunds.js';
import { getHospital, HOSPITAL_ID, type Address, type Hospital } from './hospital.js';

// #189: the Admin edits the hospital's details. Besides the Hospital fields, the Admin sets the refund and discount
// limits above which a second person approves (billing/refunds.ts, billing/discounts.ts); null puts the default back.

export interface HospitalChange {
  /** The version the Admin read. */
  version: number;
  name?: string;
  address?: Address;
  phone?: string;
  email?: string;
  mpLicenceNo?: string;
  licenceValidTill?: string | null;
  gstin?: string | null;
  pcpndtRegNo?: string | null;
  mtpRegNo?: string | null;
  invoicePrefix?: string;
  billOfSupplyPrefix?: string;
  refundLimitPaise?: number | null;
  discountLimitPaise?: number | null;
  reason?: string;
}

/** The hospital as the Admin sees it: the details plus the limits in force (the default when none is set). */
export interface AdminHospital extends Hospital {
  refundLimitPaise: number;
  discountLimitPaise: number;
}

export async function getAdminHospital(db: Queryable): Promise<AdminHospital> {
  const { rows } = await db.query('SELECT refund_limit_paise, discount_limit_paise FROM hospital WHERE id = $1', [HOSPITAL_ID]);
  const limit = (v: unknown, fallback: number) => (v == null ? fallback : Number(v));
  return {
    ...(await getHospital(db)),
    refundLimitPaise: limit(rows[0]?.refund_limit_paise, DEFAULT_REFUND_LIMIT_PAISE),
    discountLimitPaise: limit(rows[0]?.discount_limit_paise, DEFAULT_DISCOUNT_LIMIT_PAISE),
  };
}

/** The column of each changeable field. */
const COLUMNS: Record<string, string> = {
  name: 'name',
  address: 'address',
  phone: 'phone',
  email: 'email',
  mpLicenceNo: 'mp_licence_no',
  licenceValidTill: 'licence_valid_till',
  gstin: 'gstin',
  pcpndtRegNo: 'pcpndt_reg_no',
  mtpRegNo: 'mtp_reg_no',
  invoicePrefix: 'invoice_prefix',
  billOfSupplyPrefix: 'bill_of_supply_prefix',
  refundLimitPaise: 'refund_limit_paise',
  discountLimitPaise: 'discount_limit_paise',
};

/** The first day (India) of the financial year `now` falls in: 1 April. */
export function financialYearStart(now: Date): Date {
  const [year, month] = indiaDate(now).split('-').map(Number) as [number, number];
  return indiaDayStart(`${month >= 4 ? year : year - 1}-04-01`);
}

/**
 * Bill numbers read <prefix>/<yy-yy>/<n>, so a prefix may change only before the first bill of that series is numbered
 * in the financial year (409 prefix_in_use). The invoice prefix is also on credit notes and pharmacy invoices.
 */
async function assertPrefixFree(db: Queryable, field: 'invoicePrefix' | 'billOfSupplyPrefix', now: Date): Promise<void> {
  const from = financialYearStart(now);
  const invoice = field === 'invoicePrefix';
  const { rows } = await db.query(
    'SELECT 1 FROM bills WHERE series = $1 AND ((number IS NOT NULL AND finalised_at >= $2) OR (credit_note_no IS NOT NULL AND updated_at >= $2)) LIMIT 1',
    [invoice ? 'tax_invoice' : 'bill_of_supply', from],
  );
  const pharmacy = invoice && !rows[0] ? await db.query('SELECT 1 FROM pharmacy_bills WHERE number IS NOT NULL AND created_at >= $1 LIMIT 1', [from]) : { rows: [] };
  if (rows[0] || pharmacy.rows[0]) {
    throw new AppError(409, 'prefix_in_use', `bills with this prefix are already numbered this financial year; change it from 1 April ${from.getUTCFullYear() + 1}`);
  }
}

/**
 * #189: changes the fields given. 409 for a stale version, 409 prefix_in_use for a prefix changed mid financial year,
 * 422 if nothing changes. The old values and the reason are kept in the hospital's history.
 */
export async function changeHospital(
  db: Queryable,
  input: HospitalChange,
  by: string,
  now = new Date(),
): Promise<{ hospital: AdminHospital; changes: Record<string, [unknown, unknown]> }> {
  const before = await getAdminHospital(db);
  if (before.version !== input.version) throw new AppError(409, 'conflict', 'someone else saved this record first');
  const changes: Record<string, [unknown, unknown]> = {};
  const set: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = (input as unknown as Record<string, unknown>)[field];
    if (value === undefined) continue;
    const old = (before as unknown as Record<string, unknown>)[field] ?? null;
    if (JSON.stringify(old) === JSON.stringify(value)) continue;
    changes[field] = [old, value];
    set[column] = field === 'address' ? JSON.stringify(value) : value;
  }
  if (Object.keys(changes).length === 0) throw new AppError(422, 'invalid_input', 'nothing to change');
  for (const field of ['invoicePrefix', 'billOfSupplyPrefix'] as const) if (changes[field]) await assertPrefixFree(db, field, now);
  await updateRecord(db, 'hospital', { id: HOSPITAL_ID, version: input.version, by, set, reason: input.reason });
  return { hospital: await getAdminHospital(db), changes };
}
