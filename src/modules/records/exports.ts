import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import type { ExportFiles } from '../../files/exports.js';
import { AppError } from '../../middleware/errors.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { UUID } from '../users/users.js';
import { patientBundle } from './fhir.js';

// FHIR exports (api-list.md Export). One patient's bundle is small, so it is built during the request.

export interface Export extends Omit<BaseFields, 'status'> {
  status: 'running' | 'done' | 'failed';
  kind: 'patient' | 'full';
  patientId?: string;
  startedAt: string;
  finishedAt?: string;
  /** A signed link (10 minutes), only on GET #151 once done. */
  downloadUrl?: string;
}

export function toExport(r: Record<string, unknown>): Export & { s3Key: string } {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as Export['status'],
    kind: r.kind as Export['kind'],
    ...(r.patient_id != null && { patientId: String(r.patient_id) }),
    startedAt: (r.created_at as Date).toISOString(),
    ...(r.finished_at != null && { finishedAt: (r.finished_at as Date).toISOString() }),
    s3Key: String(r.s3_key),
  };
}

/** 404 for no export (or not a UUID). The S3 key is for the caller, not the API reply. */
export async function getExport(db: Queryable, id: string): Promise<Export & { s3Key: string }> {
  const { rows } = UUID.test(id) ? await db.query('SELECT * FROM exports WHERE id = $1', [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such export');
  return toExport(rows[0] as Record<string, unknown>);
}

/** #150: builds the patient's FHIR bundle into the exports bucket. A failure is saved as failed, then reported. */
export async function exportPatient(db: Queryable, patientId: string, exportFiles: ExportFiles, by: string, now = new Date()): Promise<Export> {
  const patient = await getPatient(db, patientId);
  const id = randomUUID();
  const key = `fhir/${patient.id}/${id}.json`;
  const { rows } = await db.query(
    `INSERT INTO exports (id, status, created_by, updated_by, kind, patient_id, s3_key) VALUES ($1, 'running', $2, $2, 'patient', $3, $4) RETURNING *`,
    [id, by, patient.id, key],
  );
  const version = Number(rows[0]!.version);
  try {
    await exportFiles.put(key, JSON.stringify(await patientBundle(db, patient.id, now)), 'application/fhir+json');
  } catch (err) {
    await updateRecord(db, 'exports', { id, version, by, set: { status: 'failed', finished_at: new Date() } });
    throw err;
  }
  const { s3Key: _key, ...done } = toExport(await updateRecord(db, 'exports', { id, version, by, set: { status: 'done', finished_at: new Date() } }));
  return done;
}
