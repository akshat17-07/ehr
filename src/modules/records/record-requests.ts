import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { requireEnv } from '../../config/env.js';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { ExportFiles } from '../../files/exports.js';
import type { Mailer } from '../../mail/mailer.js';
import { getHospital } from '../reference/hospital.js';
import { UUID } from '../users/users.js';
import { recordCopyHtml } from './record-copy.js';
import { AppError } from '../../middleware/errors.js';
import { getPatient, type BaseFields } from '../patients/patients.js';

// Copies of a patient's record (api-list.md RecordRequest). Each request is due 72 hours after it was made.

export const RECORD_REQUEST_STATUSES = ['pending', 'fulfilled', 'rejected'] as const;
export const RECORD_SCOPES = ['full', 'encounter', 'documents'] as const;
export const RECORD_REQUEST_HOURS = 72;

export interface RecordRequest extends Omit<BaseFields, 'status'> {
  status: (typeof RECORD_REQUEST_STATUSES)[number];
  patientId: string;
  requestedBy: 'patient' | 'counter';
  scope: (typeof RECORD_SCOPES)[number];
  encounterIds?: string[];
  includeSensitive: boolean;
  email: string;
  dueBy: string;
  shareLinkExpiresAt?: string;
}

export function toRecordRequest(r: Record<string, unknown>): RecordRequest {
  const encounterIds = JSON.parse(String(r.encounter_ids ?? '[]')) as string[];
  const created = r.created_at as Date;
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as RecordRequest['status'],
    patientId: String(r.patient_id),
    requestedBy: r.requested_by as RecordRequest['requestedBy'],
    scope: r.scope as RecordRequest['scope'],
    ...(encounterIds.length > 0 && { encounterIds }),
    includeSensitive: r.include_sensitive === true,
    email: String(r.email),
    dueBy: new Date(created.getTime() + RECORD_REQUEST_HOURS * 3_600_000).toISOString(),
    ...(r.share_link_expires_at != null && { shareLinkExpiresAt: (r.share_link_expires_at as Date).toISOString() }),
  };
}

export interface RecordRequestQuery extends PageQuery {
  status?: RecordRequest['status'];
  /** true: pending past the 72 hours; false: all others. */
  overdue?: 'true' | 'false';
}

/** #145: oldest first, so the request due soonest is on top. */
export async function listRecordRequests(db: Queryable, query: RecordRequestQuery, now = new Date()): Promise<Page<RecordRequest>> {
  const where = ['voided_at IS NULL'];
  const params: unknown[] = [];
  if (query.status) where.push(`status = $${params.push(query.status)}`);
  if (query.overdue) {
    const overdue = `(status = 'pending' AND created_at < $${params.push(new Date(now.getTime() - RECORD_REQUEST_HOURS * 3_600_000))})`;
    where.push(query.overdue === 'true' ? overdue : `NOT ${overdue}`);
  }
  return pageRows(db, { select: 'SELECT * FROM record_requests', where, params, orderBy: ['created_at', 'id'], direction: 'asc' }, query, toRecordRequest);
}

export interface NewRecordRequest {
  patientId: string;
  scope: RecordRequest['scope'];
  encounterIds?: string[];
  includeSensitive?: boolean;
  email: string;
}

/**
 * #146 (counter) and #253 (patient portal): due in 72 hours. 404 for no patient; 422 if scope encounter has no
 * encounterIds, another scope has some, or an encounter isn't the patient's.
 */
export async function createRecordRequest(
  db: Queryable,
  input: NewRecordRequest,
  requestedBy: RecordRequest['requestedBy'],
  by: string,
): Promise<RecordRequest> {
  const patient = await getPatient(db, input.patientId);
  const encounterIds = [...new Set(input.encounterIds ?? [])];
  if ((input.scope === 'encounter') !== encounterIds.length > 0) {
    throw new AppError(422, 'validation_failed', 'encounterIds: needed for scope encounter, and only then');
  }
  if (encounterIds.length > 0) {
    const { rows } = await db.query(
      `SELECT id FROM encounters WHERE patient_id = $1 AND id IN (${encounterIds.map((_, i) => `$${i + 2}`).join(', ')})`,
      [patient.id, ...encounterIds],
    );
    if (rows.length !== encounterIds.length) throw new AppError(422, 'validation_failed', "encounterIds: not this patient's");
  }
  const { rows } = await db.query(
    `INSERT INTO record_requests (id, status, created_by, updated_by, patient_id, requested_by, scope, encounter_ids, include_sensitive, email)
     VALUES ($1, 'pending', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [randomUUID(), by, patient.id, requestedBy, input.scope, JSON.stringify(encounterIds), input.includeSensitive ?? false, input.email],
  );
  return toRecordRequest(rows[0] as Record<string, unknown>);
}

/** 404 for no request (or not a UUID). */
export async function getRecordRequest(db: Queryable, id: string): Promise<RecordRequest> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM record_requests WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such record request');
  return toRecordRequest(rows[0] as Record<string, unknown>);
}

/** How long a share link works. */
export const SHARE_LINK_DAYS = 7;

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * #147: builds the copy, keeps it in the exports bucket and emails a share link that works for 7 days (opening it
 * also needs a one-time code sent to the same email, #274 / #275). 409 not_pending unless pending. The email is sent
 * inside the transaction, so if it fails nothing is saved and the request stays pending.
 */
export async function fulfilRecordRequest(
  db: Queryable,
  id: string,
  deps: { exportFiles: ExportFiles; mailer: Mailer },
  by: string,
  now = new Date(),
): Promise<RecordRequest> {
  const request = await getRecordRequest(db, id);
  if (request.status !== 'pending') throw new AppError(409, 'not_pending', `this request is ${request.status}`);
  const shareUrl = requireEnv('SHARE_URL');
  const key = `record-copies/${request.id}/${randomUUID()}.html`;
  await deps.exportFiles.put(key, await recordCopyHtml(db, request, now), 'text/html; charset=utf-8');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SHARE_LINK_DAYS * 86_400_000);
  const hospital = await getHospital(db);
  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO share_links (id, status, created_by, updated_by, record_request_id, patient_id, token_hash, s3_key, email, expires_at)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), by, request.id, request.patientId, tokenHash(token), key, request.email, expiresAt],
    );
    await updateRecord(tx, 'record_requests', { id: request.id, version: request.version, by, set: { status: 'fulfilled', share_link_expires_at: expiresAt } });
    await deps.mailer.send({
      to: request.email,
      subject: `${hospital.name}: your record copy`,
      text: [
        `Your record copy from ${hospital.name} is ready.`,
        `Open it here: ${shareUrl}${token}`,
        `The link works for ${SHARE_LINK_DAYS} days. To open it you will get a one-time code at this email address.`,
        `If you did not ask for this, call ${hospital.phone}.`,
      ].join('\n\n'),
    });
  });
  return getRecordRequest(db, request.id);
}
