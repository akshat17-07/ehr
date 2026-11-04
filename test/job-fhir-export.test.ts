import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { handler } from '../src/handler.js';
import { isJobEvent, runJob } from '../src/jobs/index.js';
import { patientBundle } from '../src/modules/records/fhir.js';

type Db = Awaited<ReturnType<typeof openLocalDb>>;
const fakeFiles = (fail = false) => {
  const puts: { key: string; body: Uint8Array; mime: string; encoding?: string }[] = [];
  return {
    puts,
    files: {
      put: async (key: string, body: string | Uint8Array, mime: string, encoding?: 'gzip') => {
        if (fail) throw new Error('S3 down');
        puts.push({ key, body: body as Uint8Array, mime, ...(encoding && { encoding }) });
      },
    },
  };
};
const ndjson = (body: Uint8Array) =>
  gunzipSync(body).toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as { resourceType: string; id: string });
const patientIds = (lines: { resourceType: string; id: string }[]) => lines.filter((l) => l.resourceType === 'Patient').map((l) => l.id).sort();

async function setup() {
  const db = await openLocalDb();
  await seedDev(db);
  // One voided patient, and one allergy for another patient.
  await db.query("UPDATE patients SET voided_at = now(), voided_by = 'test', void_reason = 'dup' WHERE id = $1", [seedId('9a710000', 2)]);
  await db.query(
    `INSERT INTO allergies (id, status, created_by, updated_by, created_at, updated_at, patient_id, substance, severity) VALUES ($1, 'active', 't', 't', now(), now(), $2, 'Dust', 'mild')`,
    [randomUUID(), seedId('9a710000', 3)],
  );
  return db;
}
async function newExport(db: Db, status = 'running', kind = 'full') {
  const id = randomUUID();
  await db.query(`INSERT INTO exports (id, status, created_by, updated_by, kind, s3_key) VALUES ($1, $2, 't', 't', $3, $4)`, [
    id, status, kind, `fhir/full/${id}/export.ndjson.gz`,
  ]);
  return id;
}
const exportRow = async (db: Db, id: string) => (await db.query('SELECT * FROM exports WHERE id = $1', [id])).rows[0]!;
const livePatients = async (db: Db) => (await db.query('SELECT id FROM patients WHERE voided_at IS NULL ORDER BY id')).rows.map((r) => String(r.id));

describe('fhir_export job', () => {
  it('writes every live patient as gzip NDJSON, one FHIR resource per line, and marks the row done', async () => {
    const db = await setup();
    const id = await newExport(db);
    const { puts, files } = fakeFiles();
    await runJob({ job: 'fhir_export', exportId: id }, { db, exportFiles: files });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ key: `fhir/full/${id}/export.ndjson.gz`, mime: 'application/x-ndjson', encoding: 'gzip' });
    const lines = ndjson(puts[0]!.body);
    for (const l of lines) expect(typeof l.resourceType).toBe('string');
    const patients = await livePatients(db);
    expect(patients.length).toBeGreaterThan(2);
    expect(patientIds(lines)).toEqual(patients);
    expect(patientIds(lines)).not.toContain(seedId('9a710000', 2));
    let expected = 0;
    for (const p of patients) expected += ((await patientBundle(db, p)) as { entry: unknown[] }).entry.length;
    expect(lines).toHaveLength(expected);
    expect(lines.some((l) => l.resourceType === 'AllergyIntolerance')).toBe(true);
    const row = await exportRow(db, id);
    expect(row.status).toBe('done');
    expect(row.finished_at).not.toBeNull();
  });

  it('since: only patients changed since then', async () => {
    const db = await setup();
    for (const t of ['patients', 'encounters', 'diagnoses', 'prescriptions', 'allergies', 'documents']) {
      await db.query(`UPDATE ${t} SET updated_at = '2020-01-01T00:00:00Z'`);
    }
    // Only one patient's allergy changes after the cut-off.
    await db.query("UPDATE allergies SET updated_at = '2026-06-01T00:00:00Z' WHERE substance = 'Dust'");
    const id = await newExport(db);
    const { puts, files } = fakeFiles();
    await runJob({ job: 'fhir_export', exportId: id, since: '2026-01-01T00:00:00.000Z' }, { db, exportFiles: files });
    expect(patientIds(ndjson(puts[0]!.body))).toEqual([seedId('9a710000', 3)]);
    // A patient's own change counts too.
    const id2 = await newExport(db);
    await db.query("UPDATE patients SET updated_at = '2026-07-01T00:00:00Z' WHERE id = $1", [seedId('9a710000', 1)]);
    const second = fakeFiles();
    await runJob({ job: 'fhir_export', exportId: id2, since: '2026-01-01T00:00:00.000Z' }, { db, exportFiles: second.files });
    expect(patientIds(ndjson(second.puts[0]!.body))).toEqual([seedId('9a710000', 1), seedId('9a710000', 3)]);
  });

  it('a row that is not running (or not full) changes nothing and writes nothing', async () => {
    const db = await setup();
    const { puts, files } = fakeFiles();
    for (const [status, kind] of [['done', 'full'], ['failed', 'full'], ['running', 'patient']] as const) {
      const id = await newExport(db, status, kind);
      await runJob({ job: 'fhir_export', exportId: id }, { db, exportFiles: files });
      expect((await exportRow(db, id)).status).toBe(status);
    }
    expect(puts).toHaveLength(0);
  });

  it('a failed put saves the row as failed and throws', async () => {
    const db = await setup();
    const id = await newExport(db);
    await expect(runJob({ job: 'fhir_export', exportId: id }, { db, exportFiles: fakeFiles(true).files })).rejects.toThrow('S3 down');
    const row = await exportRow(db, id);
    expect(row.status).toBe('failed');
    expect(row.finished_at).not.toBeNull();
  });

  it('needs an exportId; a missing export throws', async () => {
    const db = await setup();
    await expect(runJob({ job: 'fhir_export' }, { db, exportFiles: fakeFiles().files })).rejects.toThrow('exportId');
    await expect(runJob({ job: 'fhir_export', exportId: randomUUID() }, { db, exportFiles: fakeFiles().files })).rejects.toMatchObject({ status: 404 });
  });
});

describe('job events', () => {
  it('isJobEvent checks exportId and since', () => {
    expect(isJobEvent({ job: 'fhir_export', exportId: randomUUID() })).toBe(true);
    expect(isJobEvent({ job: 'fhir_export', exportId: randomUUID(), since: '2026-01-01T00:00:00Z' })).toBe(true);
    expect(isJobEvent({ job: 'fhir_export', exportId: 'nope' })).toBe(false);
    expect(isJobEvent({ job: 'fhir_export', exportId: 5 })).toBe(false);
    expect(isJobEvent({ job: 'fhir_export', since: 'yesterday' })).toBe(false);
    expect(isJobEvent({ job: 'stock_scan' })).toBe(true);
  });

  it('the Lambda handler sends a job event with an exportId to the job (not the HTTP app)', async () => {
    // The export does not exist in the handler's own database, so the job answers 404 instead of an HTTP response.
    await expect(handler({ job: 'fhir_export', exportId: randomUUID() }, {})).rejects.toMatchObject({ status: 404 });
  });
});
