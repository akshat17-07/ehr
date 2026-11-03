import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { UUID } from '../users/users.js';
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

/**
 * #201: links a GP login (users.id, type gp) to a referrer and makes it a real record (pseudo false).
 * 404 missing; 409 merged / already_attached / user_attached; 422 if the user is not a GP login.
 */
export async function attachReferrerUser(db: Queryable, id: string, input: { userId: string; reason: string }, by: string): Promise<Referrer> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM referrers WHERE id = $1', [id]) : { rows: [] };
  const current = rows[0] as Record<string, unknown> | undefined;
  if (!current) throw new AppError(404, 'not_found');
  if (current.merged_into) throw new AppError(409, 'merged', 'this referrer was merged into another');
  if (current.user_id) throw new AppError(409, 'already_attached', 'this referrer already has a login');
  const user = (await db.query('SELECT type FROM users WHERE id = $1', [input.userId])).rows[0];
  if (!user || user.type !== 'gp') throw new AppError(422, 'invalid_input', 'user must be a GP login');
  const taken = (await db.query('SELECT 1 FROM referrers WHERE user_id = $1 AND id <> $2', [input.userId, id])).rows[0];
  if (taken) throw new AppError(409, 'user_attached', 'this login is already linked to another referrer');
  const saved = await updateRecord(db, 'referrers', {
    id,
    version: current.version as number,
    by,
    reason: input.reason,
    set: { user_id: input.userId, pseudo: false },
  });
  return toReferrer(saved);
}

export interface MergedReferrer {
  referrer: Referrer;
  /** Ids of the rows moved to the kept referrer, kept in the audit so the merge can be traced. */
  movedReferralIds: string[];
  movedPatientIds: string[];
}

/**
 * #202: merges duplicate referrer `id` into `intoReferrerId`. Its referrals and patients move to the kept one; a login on
 * the duplicate moves too if the kept one has none (409 both_attached if both have one). Nothing is deleted.
 */
export async function mergeReferrers(db: Queryable, id: string, input: { intoReferrerId: string; reason: string }, by: string): Promise<MergedReferrer> {
  const targetId = input.intoReferrerId;
  if (!UUID.test(id)) throw new AppError(404, 'not_found');
  if (id === targetId) throw new AppError(422, 'invalid_input', 'intoReferrerId: cannot merge a referrer into itself');
  return withTransaction(db, async (tx) => {
    const dup = (await tx.query('SELECT * FROM referrers WHERE id = $1', [id])).rows[0];
    if (!dup) throw new AppError(404, 'not_found');
    const target = (await tx.query('SELECT * FROM referrers WHERE id = $1', [targetId])).rows[0];
    if (!target) throw new AppError(404, 'not_found', 'target referrer not found');
    if (dup.merged_into || target.merged_into) throw new AppError(409, 'merged', 'a referrer here was already merged into another');
    if (dup.user_id && target.user_id) throw new AppError(409, 'both_attached', 'both referrers have a login; detach one first');
    const moveLogin = Boolean(dup.user_id && !target.user_id);

    const movedReferralIds = (await tx.query('UPDATE referrals SET referrer_id = $1 WHERE referrer_id = $2 RETURNING id', [targetId, id])).rows.map((r) => String(r.id));
    const movedPatientIds = (await tx.query('UPDATE patients SET referrer_id = $1 WHERE referrer_id = $2 RETURNING id', [targetId, id])).rows.map((r) => String(r.id));
    const saved = await updateRecord(tx, 'referrers', {
      id,
      version: dup.version as number,
      by,
      reason: `${input.reason} (moved ${movedReferralIds.length} referrals, ${movedPatientIds.length} patients)`,
      set: { merged_into: targetId, ...(moveLogin && { user_id: null }) },
    });
    if (moveLogin) {
      await updateRecord(tx, 'referrers', {
        id: targetId,
        version: target.version as number,
        by,
        reason: `login moved from merged referrer ${id}: ${input.reason}`,
        set: { user_id: dup.user_id, pseudo: false },
      });
    }
    return { referrer: toReferrer(saved), movedReferralIds, movedPatientIds };
  });
}
