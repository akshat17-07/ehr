import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { LINK_SECONDS, type SignGetUrl } from '../../files/signed-url.js';
import { UPLOAD_SECONDS, type FileUploads } from '../../files/uploads.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDayStart } from '../../time/india.js';
import { getPatient, type BaseFields } from '../patients/patients.js';

// Patient documents (api-list.md Document): photos and PDFs of prescriptions, reports, consents. The file lives in
// the Object-Locked files bucket; this row says whose it is and what it is. Nothing is ever deleted: a file on the
// wrong patient is marked misfiled (#99).

export const DOCUMENT_TYPES = ['prescription', 'lab_report', 'imaging', 'consent', 'id_proof', 'insurance', 'discharge', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DOCUMENT_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export interface Document extends Omit<BaseFields, 'status'> {
  status: 'pending' | 'ready' | 'misfiled';
  patientId: string;
  type: DocumentType;
  fileName: string;
  mime: (typeof DOCUMENT_MIMES)[number];
  sizeBytes: number;
  sha256: string;
  uploadedAt?: string;
}

export function toDocument(r: Record<string, unknown>): Document {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as Document['status'],
    patientId: String(r.patient_id),
    type: r.type as DocumentType,
    fileName: String(r.file_name),
    mime: r.mime as Document['mime'],
    sizeBytes: Number(r.size_bytes),
    sha256: String(r.sha256),
    ...(r.uploaded_at != null && { uploadedAt: (r.uploaded_at as Date).toISOString() }),
  };
}

export interface NewDocument {
  patientId: string;
  type: DocumentType;
  fileName: string;
  mime: Document['mime'];
  sizeBytes: number;
  sha256: string;
}

export type UploadStart =
  | { document: Document; duplicate: true }
  | { document: Document; uploadUrl: string; uploadHeaders: Record<string, string>; expiresAt: string };

/**
 * #94: a signed link to upload one file. If the patient already has this file (same SHA-256) it is not stored
 * again: the existing document comes back with `duplicate`. A link asked for again (upload not done) is renewed.
 */
export async function startUpload(
  db: Queryable,
  files: FileUploads,
  bucket: string,
  input: NewDocument,
  by: string,
  now = new Date(),
): Promise<UploadStart> {
  const patient = await getPatient(db, input.patientId, now);
  const { rows: same } = await db.query(
    "SELECT * FROM documents WHERE patient_id = $1 AND sha256 = $2 AND status IN ('pending', 'ready') ORDER BY created_at, id",
    [patient.id, input.sha256],
  );
  const ready = same.find((r) => r.status === 'ready');
  if (ready) return { document: toDocument(ready as Record<string, unknown>), duplicate: true };

  let row = same[0] as Record<string, unknown> | undefined;
  if (!row) {
    const id = randomUUID();
    const { rows } = await db.query(
      `INSERT INTO documents (id, status, created_by, updated_by, patient_id, type, file_name, mime, size_bytes, sha256, s3_key)
       VALUES ($1, 'pending', $2, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, by, patient.id, input.type, input.fileName, input.mime, input.sizeBytes, input.sha256, `patients/${patient.id}/${id}`],
    );
    row = rows[0] as Record<string, unknown>;
  }
  const document = toDocument(row);
  const { url, headers } = await files.signPut(bucket, String(row.s3_key), document, UPLOAD_SECONDS);
  return { document, uploadUrl: url, uploadHeaders: headers, expiresAt: new Date(now.getTime() + UPLOAD_SECONDS * 1000).toISOString() };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function documentRow(db: Queryable, id: string): Promise<Record<string, unknown>> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM documents WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such document');
  return rows[0] as Record<string, unknown>;
}

/** One document; 404 if there is none. */
export async function getDocument(db: Queryable, id: string): Promise<Document> {
  return toDocument(await documentRow(db, id));
}

/**
 * #95: after the browser's upload. The stored file must have the size and SHA-256 given at #94 (422 otherwise; the
 * document stays pending). Completing a ready document again just returns it.
 */
export async function completeUpload(db: Queryable, files: FileUploads, bucket: string, id: string, by: string, now = new Date()): Promise<Document> {
  const row = await documentRow(db, id);
  const document = toDocument(row);
  if (document.status === 'ready') return document;
  if (document.status === 'misfiled') throw new AppError(409, 'misfiled', 'this document is marked misfiled');
  const stored = await files.head(bucket, String(row.s3_key));
  if (!stored) throw new AppError(422, 'not_uploaded', 'the file is not uploaded yet');
  if (stored.sizeBytes !== document.sizeBytes || stored.sha256 !== document.sha256) {
    throw new AppError(422, 'file_mismatch', 'the uploaded file is not the one described (size or SHA-256 differs)');
  }
  await updateRecord(db, 'documents', { id, version: document.version, by, set: { status: 'ready', uploaded_at: now } });
  return getDocument(db, id);
}

/** 422 unless each id is an uploaded (ready) document of this patient. For links from other records (#27, #60, #82...). */
export async function assertPatientDocuments(db: Queryable, patientId: string, ids: string[], field: string): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const { rows } = await db.query(
    `SELECT id FROM documents WHERE patient_id = $1 AND status = 'ready' AND id IN (${unique.map((_, i) => `$${i + 2}`).join(', ')})`,
    [patientId, ...unique],
  );
  if (rows.length !== unique.length) throw new AppError(422, 'invalid_input', `${field}: each must be an uploaded document of this patient`);
}

export interface DocumentQuery extends PageQuery {
  type?: DocumentType;
  from?: string;
  to?: string;
  includeMisfiled?: 'true' | 'false';
}

/**
 * #96: a patient's uploaded documents, newest first (IST days for from/to). Uploads not yet completed are left out;
 * misfiled ones only when asked for.
 */
export async function patientDocuments(db: Queryable, patientId: string, query: DocumentQuery): Promise<Page<Document>> {
  const params: unknown[] = [patientId];
  const where = ['patient_id = $1', query.includeMisfiled === 'true' ? "status IN ('ready', 'misfiled')" : "status = 'ready'"];
  if (query.type) where.push(`type = $${params.push(query.type)}`);
  if (query.from) where.push(`created_at >= $${params.push(indiaDayStart(query.from))}`);
  if (query.to) where.push(`created_at < $${params.push(new Date(indiaDayStart(query.to).getTime() + 86_400_000))}`);
  return pageRows(db, { select: 'SELECT * FROM documents', where, params, orderBy: ['created_at', 'id'] }, query, toDocument);
}

/** #97: a 10-minute link to open the file (misfiled ones too, so they can be checked); 409 while still uploading. */
export async function documentViewUrl(
  db: Queryable,
  sign: SignGetUrl,
  bucket: string,
  id: string,
  now = new Date(),
): Promise<{ document: Document; url: string; expiresAt: string }> {
  const row = await documentRow(db, id);
  const document = toDocument(row);
  if (document.status === 'pending') throw new AppError(409, 'not_uploaded', 'the upload is not complete yet');
  return {
    document,
    url: await sign(bucket, String(row.s3_key), LINK_SECONDS),
    expiresAt: new Date(now.getTime() + LINK_SECONDS * 1000).toISOString(),
  };
}

/** #98: fix a document's type (a lab report filed as "other"); 409 once it is marked misfiled. */
export async function retagDocument(db: Queryable, id: string, input: { version: number; type: DocumentType }, by: string): Promise<Document> {
  const document = await getDocument(db, id);
  if (document.status === 'misfiled') throw new AppError(409, 'misfiled', 'this document is marked misfiled');
  return toDocument(await updateRecord(db, 'documents', { id, version: input.version, by, set: { type: input.type } }));
}
