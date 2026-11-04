import { randomUUID } from 'node:crypto';
import { createGzip } from 'node:zlib';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { s3Exports } from '../../files/exports.js';
import type { JobDeps } from '../../jobs/alert-digest.js';
import type { StartJob } from '../../jobs/start-job.js';
import { getExport, toExport, type Export } from './exports.js';
import { patientBundle } from './fhir.js';

// Full FHIR export of every patient (api-list.md #348, #349). The API only makes the `exports` row and starts the
// fhir_export job on the jobs Lambda; the job writes the file. `since` travels in the job event, not in the row.

const PAGE = 200;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** #348: a running row, then the job. If the job cannot be started the row is saved as failed and the error is raised. */
export async function startFullExport(db: Queryable, input: { since?: Date }, by: string, startJob: StartJob): Promise<Export> {
  const id = randomUUID();
  const { rows } = await db.query(
    `INSERT INTO exports (id, status, created_by, updated_by, kind, s3_key) VALUES ($1, 'running', $2, $2, 'full', $3) RETURNING *`,
    [id, by, `fhir/full/${id}/export.ndjson.gz`],
  );
  const version = Number(rows[0]!.version);
  try {
    await startJob({ job: 'fhir_export', exportId: id, ...(input.since && { since: input.since.toISOString() }) });
  } catch (err) {
    await updateRecord(db, 'exports', { id, version, by, set: { status: 'failed', finished_at: new Date() } });
    throw err;
  }
  const { s3Key: _key, ...running } = toExport(rows[0]!);
  return running;
}

/** Patients (not voided) after `afterId`, by id; with `since` only those whose own row or a bundle row changed then. */
async function patientIds(db: Queryable, afterId: string, since?: Date): Promise<string[]> {
  const changed = since
    ? ` AND (updated_at >= $2 OR ${['encounters', 'diagnoses', 'prescriptions', 'allergies', 'documents']
        .map((t) => `EXISTS (SELECT 1 FROM ${t} x WHERE x.patient_id = patients.id AND x.updated_at >= $2)`)
        .join(' OR ')})`
    : '';
  const { rows } = await db.query(
    `SELECT id FROM patients WHERE voided_at IS NULL AND id > $1::uuid${changed} ORDER BY id LIMIT ${PAGE}`,
    since ? [afterId, since] : [afterId],
  );
  return rows.map((r) => String(r.id));
}

/**
 * The fhir_export job: every patient's bundle resources, one per NDJSON line, into one gzip file at the row's s3_key
 * (content type application/x-ndjson, content encoding gzip). A retried event for a row that is not running changes
 * nothing. Any error saves the row as failed and is re-thrown, so the Lambda error alarm fires.
 * Gap: the whole gzip is held in memory before one put (ExportFiles is put-only); fine at this hospital's size.
 */
export async function fullExportJob({ db, now = new Date(), exportFiles = s3Exports, exportId, since }: JobDeps): Promise<void> {
  if (!exportId) throw new Error('fhir_export needs an exportId');
  const row = await getExport(db, exportId);
  if (row.kind !== 'full' || row.status !== 'running') {
    console.log(JSON.stringify({ msg: 'fhir_export skipped', exportId, kind: row.kind, status: row.status }));
    return;
  }
  const by = 'fhir_export';
  const { rows: cur } = await db.query('SELECT version FROM exports WHERE id = $1', [exportId]);
  const version = Number(cur[0]!.version);
  try {
    const sinceDate = since ? new Date(since) : undefined;
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve, reject) => {
      gzip.on('end', resolve);
      gzip.on('error', reject);
    });
    let patients = 0;
    let resources = 0;
    for (let after = NIL_UUID; ; ) {
      const ids = await patientIds(db, after, sinceDate);
      if (ids.length === 0) break;
      for (const id of ids) {
        const bundle = (await patientBundle(db, id, now)) as { entry: { resource: unknown }[] };
        patients++;
        for (const { resource } of bundle.entry) {
          gzip.write(`${JSON.stringify(resource)}\n`);
          resources++;
        }
      }
      after = ids[ids.length - 1]!;
    }
    gzip.end();
    await finished;
    const body = Buffer.concat(chunks);
    await exportFiles.put(row.s3Key, body, 'application/x-ndjson', 'gzip');
    await updateRecord(db, 'exports', { id: exportId, version, by, set: { status: 'done', finished_at: new Date() } });
    console.log(JSON.stringify({ msg: 'fhir_export done', exportId, patients, resources, sizeBytes: body.length }));
  } catch (err) {
    await updateRecord(db, 'exports', { id: exportId, version, by, set: { status: 'failed', finished_at: new Date() } });
    throw err;
  }
}
