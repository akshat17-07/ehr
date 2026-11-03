import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';

// Monthly access reviews (api-list.md AccessReview, #342-#343). One review per month, never edited.

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const reviewListQuery = z.object({ year: z.string().regex(/^\d{4}$/).optional() }).strict();
export type ReviewListQuery = z.infer<typeof reviewListQuery>;

export const newReviewBody = z
  .object({
    month: monthSchema,
    notes: z.string().trim().min(1).max(5000),
    findings: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
  })
  .strict();
export type NewReviewBody = z.infer<typeof newReviewBody>;

export interface AccessReview {
  id: string;
  month: string;
  reviewedBy: string | null;
  reviewedAt: string;
  notes: string;
  findings: string[];
}

const SELECT = 'SELECT r.*, u.id AS reviewer_row_id FROM access_reviews r LEFT JOIN users u ON u.cognito_sub = r.reviewed_by';

function toAccessReview(r: Record<string, unknown>): AccessReview {
  return {
    id: String(r.id),
    month: String(r.month),
    reviewedBy: r.reviewed_by == null ? null : String(r.reviewer_row_id ?? r.reviewed_by),
    reviewedAt: (r.created_at as Date).toISOString(),
    notes: String(r.notes),
    findings: JSON.parse(String(r.findings)) as string[],
  };
}

/** #342: newest month first; `year` keeps one calendar year. Voided rows are left out. */
export async function listAccessReviews(db: Queryable, query: ReviewListQuery): Promise<{ items: AccessReview[] }> {
  const where = ['r.voided_at IS NULL'];
  const params: unknown[] = [];
  if (query.year) where.push(`r.month LIKE $${params.push(`${query.year}-%`)}`);
  const { rows } = await db.query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.month DESC`, params);
  return { items: rows.map((r) => toAccessReview(r as Record<string, unknown>)) };
}

/** #343: 422 for a month in the future (India time); 409 when that month already has a review. */
export async function createAccessReview(db: Queryable, input: NewReviewBody, by: string): Promise<AccessReview> {
  if (input.month > indiaDate().slice(0, 7)) throw new AppError(422, 'invalid_month', 'month cannot be in the future');
  const existing = (await db.query('SELECT 1 FROM access_reviews WHERE month = $1 AND voided_at IS NULL', [input.month])).rows[0];
  if (existing) throw new AppError(409, 'already_reviewed', 'this month already has an access review');
  const id = randomUUID();
  await db.query(
    `INSERT INTO access_reviews (id, status, created_by, updated_by, month, notes, findings, reviewed_by)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $2)`,
    [id, by, input.month, input.notes, JSON.stringify(input.findings ?? [])],
  );
  const row = (await db.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0];
  return toAccessReview(row as Record<string, unknown>);
}
