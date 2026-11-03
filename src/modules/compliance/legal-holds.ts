import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { pageQuery, pageRows, type Page } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';

// Legal holds on a patient's record (api-list.md LegalHold, #337-#339). status: active / released.
// The S3 object-lock on the patient's files is infra work, done later; this is the register.

export const holdListQuery = pageQuery.extend({ active: z.enum(['true', 'false']).optional() }).strict();
export type HoldListQuery = z.infer<typeof holdListQuery>;

export const newHoldBody = z
  .object({ patientId: z.uuid(), reason: z.string().trim().min(1).max(1000), reference: z.string().trim().min(1).max(200).optional() })
  .strict();
export type NewHoldBody = z.infer<typeof newHoldBody>;

export const releaseHoldBody = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

export interface LegalHold {
  id: string;
  version: number;
  status: string;
  patientId: string;
  uhid: string | null;
  patientName: string | null;
  reason: string;
  reference: string | null;
  placedBy: string | null;
  placedAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
  releaseReason: string | null;
}

// placedBy / releasedBy are users.id; the stored sub is kept when no user row has it.
const SELECT = `SELECT h.*, p.uhid, p.name AS patient_name, up.id AS placer_row_id, ur.id AS releaser_row_id
  FROM legal_holds h LEFT JOIN patients p ON p.id = h.patient_id
  LEFT JOIN users up ON up.cognito_sub = h.placed_by LEFT JOIN users ur ON ur.cognito_sub = h.released_by`;

export function toLegalHold(r: Record<string, unknown>): LegalHold {
  const base = baseFields(r as unknown as BaseRow);
  return {
    id: base.id,
    version: base.version,
    status: base.status,
    patientId: String(r.patient_id),
    uhid: r.uhid == null ? null : String(r.uhid),
    patientName: r.patient_name == null ? null : String(r.patient_name),
    reason: String(r.reason),
    reference: r.reference == null ? null : String(r.reference),
    placedBy: r.placed_by == null ? null : String(r.placer_row_id ?? r.placed_by),
    placedAt: base.createdAt,
    releasedAt: r.released_at == null ? null : (r.released_at as Date).toISOString(),
    releasedBy: r.released_by == null ? null : String(r.releaser_row_id ?? r.released_by),
    releaseReason: r.release_reason == null ? null : String(r.release_reason),
  };
}

async function fetchHold(db: Queryable, id: string): Promise<LegalHold> {
  const row = (await db.query(`${SELECT} WHERE h.id = $1`, [id])).rows[0];
  return toLegalHold(row as Record<string, unknown>);
}

/** #337: newest first; `active` true = holds in force, false = released ones. Voided holds are left out. */
export function listLegalHolds(db: Queryable, query: HoldListQuery): Promise<Page<LegalHold>> {
  const where: string[] = ['h.voided_at IS NULL'];
  const params: unknown[] = [];
  if (query.active) where.push(`h.status = $${params.push(query.active === 'true' ? 'active' : 'released')}`);
  return pageRows(db, { select: SELECT, where, params, orderBy: ['h.created_at', 'h.id'], direction: 'desc' }, query, toLegalHold);
}

/** #338: one active hold per patient. */
export async function placeLegalHold(db: Queryable, input: NewHoldBody, by: string): Promise<LegalHold> {
  const patient = (await db.query('SELECT 1 FROM patients WHERE id = $1', [input.patientId])).rows[0];
  if (!patient) throw new AppError(404, 'patient_not_found');
  const held = (await db.query("SELECT 1 FROM legal_holds WHERE patient_id = $1 AND status = 'active' AND voided_at IS NULL", [input.patientId])).rows[0];
  if (held) throw new AppError(409, 'already_held', 'this patient already has an active legal hold');
  const id = randomUUID();
  await db.query(
    `INSERT INTO legal_holds (id, status, created_by, updated_by, patient_id, reason, reference, placed_by)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $2)`,
    [id, by, input.patientId, input.reason, input.reference ?? null],
  );
  return fetchHold(db, id);
}

/** #339: lifts an active hold; the reason is kept on the hold and in its history. */
export async function releaseLegalHold(db: Queryable, id: string, reason: string, by: string): Promise<LegalHold> {
  if (!z.uuid().safeParse(id).success) throw new AppError(404, 'not_found');
  const current = (await db.query('SELECT version, status, voided_at FROM legal_holds WHERE id = $1', [id])).rows[0];
  if (!current || current.voided_at) throw new AppError(404, 'not_found');
  if (current.status !== 'active') throw new AppError(409, 'not_active', 'this hold is already released');
  await updateRecord(db, 'legal_holds', {
    id,
    version: Number(current.version),
    by,
    reason,
    set: { status: 'released', released_at: new Date(), released_by: by, release_reason: reason },
  });
  return fetchHold(db, id);
}
