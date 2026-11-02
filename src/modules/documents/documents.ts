import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { UPLOAD_SECONDS, type FileUploads } from '../../files/uploads.js';
import { AppError } from '../../middleware/errors.js';
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
