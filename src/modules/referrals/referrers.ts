import type { Queryable } from '../../db/migrate.js';
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
