import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { BaseFields } from '../patients/patients.js';

// Referring doctors and clinics (api-list.md Referrer). No fee or commission is ever kept.

export interface Referrer extends BaseFields {
  name: string;
  clinic?: string;
  town?: string;
  phone?: string;
  regNo?: string;
  /** The GP login that claimed this record. */
  userId?: string;
  /** Set when this record was a duplicate, merged into that one. */
  mergedInto?: string;
  pseudo: boolean;
}

const opt = (v: unknown) => (v == null ? undefined : String(v));

export function toReferrer(r: Record<string, unknown>): Referrer {
  const [clinic, town, phone, regNo, userId, mergedInto] = [r.clinic, r.town, r.phone, r.reg_no, r.user_id, r.merged_into].map(opt);
  return {
    ...baseFields(r as unknown as BaseRow),
    name: String(r.name),
    ...(clinic && { clinic }),
    ...(town && { town }),
    ...(phone && { phone }),
    ...(regNo && { regNo }),
    ...(userId && { userId }),
    ...(mergedInto && { mergedInto }),
    pseudo: r.pseudo === true,
  };
}

/** #141: by part of the name, or the exact phone or registration number; merged and voided records are left out. A to Z. */
export async function searchReferrers(db: Queryable, query: { q: string; limit: number }): Promise<Referrer[]> {
  const q = query.q.trim();
  const { rows } = await db.query(
    `SELECT * FROM referrers WHERE merged_into IS NULL AND voided_at IS NULL AND (name_search LIKE $1 OR phone = $2 OR upper(reg_no) = upper($2))
     ORDER BY name_search, id LIMIT $3`,
    [`%${q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`, q, query.limit],
  );
  return rows.map(toReferrer);
}

export interface NewReferrer {
  name: string;
  clinic?: string;
  town?: string;
  phone?: string;
  regNo?: string;
  /** Skip the duplicate check (the person checked the matches). */
  force?: boolean;
}

/**
 * #142: a referrer typed in by staff (pseudo until a GP login claims it). 409 possible_duplicate with the matches if
 * the phone or registration number is already on file; resend with force.
 */
export async function addReferrer(db: Queryable, input: NewReferrer, by: string): Promise<Referrer> {
  if (!input.force && (input.phone || input.regNo)) {
    const { rows } = await db.query(
      'SELECT * FROM referrers WHERE merged_into IS NULL AND voided_at IS NULL AND (phone = $1 OR upper(reg_no) = upper($2)) ORDER BY name_search, id',
      [input.phone ?? null, input.regNo ?? null],
    );
    if (rows.length > 0) throw new AppError(409, 'possible_duplicate', 'a referrer with this phone or reg no. is on file', { matches: rows.map(toReferrer) });
  }
  const { rows } = await db.query(
    `INSERT INTO referrers (id, status, created_by, updated_by, name, name_search, clinic, town, phone, reg_no, pseudo)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, true) RETURNING *`,
    [randomUUID(), by, input.name, input.name.toLowerCase(), input.clinic ?? null, input.town ?? null, input.phone ?? null, input.regNo ?? null],
  );
  return toReferrer(rows[0] as Record<string, unknown>);
}

/** 422 unless `id` is a referrer on file (not merged away or voided). */
export async function assertReferrer(db: Queryable, id: string, field = 'referrerId'): Promise<void> {
  const { rows } = await db.query('SELECT 1 FROM referrers WHERE id = $1 AND merged_into IS NULL AND voided_at IS NULL', [id]);
  if (!rows[0]) throw new AppError(422, 'validation_failed', `${field}: no such referrer`);
}
