import type { Queryable } from '../db/migrate.js';

// What the backup jobs have done lately (api-list.md BackupStatus), read from job_runs. Shared by the nightly
// backup_check job (#504) and GET /admin/backup-status (#344).

export const MAX_AGE_HOURS = 26;
export const BACKUP_JOBS = ['backup_export', 'audit_export'] as const;

export interface JobStatus {
  job: string;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastSuccessAt: string | null;
  s3Key: string | null;
  sizeBytes: number | null;
  fresh: boolean;
}

export interface BackupStatus {
  ok: boolean;
  lastExportAt: string | null;
  lastExportSizeBytes: number | null;
  // Not tracked anywhere yet (no PC-download or restore-drill record exists), so always null.
  lastPcDownloadAt: null;
  lastRestoreDrillAt: null;
  jobs: JobStatus[];
  problems: string[];
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : new Date(String(v)).toISOString());

export async function backupStatus(db: Queryable, now = new Date()): Promise<BackupStatus> {
  const jobs: JobStatus[] = [];
  const problems: string[] = [];
  for (const job of BACKUP_JOBS) {
    const latest = (await db.query('SELECT started_at, ok FROM job_runs WHERE job = $1 ORDER BY started_at DESC, id LIMIT 1', [job])).rows[0];
    // A skipped run (no s3_key) is not a backup.
    const success = (
      await db.query(
        'SELECT started_at, finished_at, s3_key, size_bytes::text AS size FROM job_runs WHERE job = $1 AND ok = true AND s3_key IS NOT NULL ORDER BY started_at DESC, id LIMIT 1',
        [job],
      )
    ).rows[0];
    const doneAt = success ? iso(success.finished_at ?? success.started_at) : null;
    const fresh = doneAt !== null && now.getTime() - new Date(doneAt).getTime() <= MAX_AGE_HOURS * 3_600_000;
    if (!fresh) problems.push(`${job}: no successful run in ${MAX_AGE_HOURS}h`);
    if (latest && latest.ok === false) problems.push(`${job}: last run failed`);
    jobs.push({
      job,
      lastRunAt: latest ? iso(latest.started_at) : null,
      lastRunOk: latest ? Boolean(latest.ok) : null,
      lastSuccessAt: doneAt,
      s3Key: success ? String(success.s3_key) : null,
      sizeBytes: success && success.size != null ? Number(success.size) : null,
      fresh,
    });
  }
  const exp = jobs.find((j) => j.job === 'backup_export')!;
  return {
    ok: problems.length === 0,
    lastExportAt: exp.lastSuccessAt,
    lastExportSizeBytes: exp.sizeBytes,
    lastPcDownloadAt: null,
    lastRestoreDrillAt: null,
    jobs,
    problems,
  };
}
