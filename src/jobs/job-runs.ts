import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/migrate.js';

// job_runs (migration 0101): one row per run of a job that keeps a record of itself. Never deleted.

export interface RunRow {
  job: string;
  startedAt: Date;
  ok: boolean;
  detail: Record<string, unknown>;
  lastSeq?: number;
  s3Key?: string;
  sizeBytes?: number;
}

export async function recordRun(db: Queryable, run: RunRow): Promise<void> {
  await db.query(
    `INSERT INTO job_runs (id, status, created_by, updated_by, job, started_at, finished_at, ok, detail, last_seq, s3_key, size_bytes)
     VALUES ($1, 'done', $2, $2, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [randomUUID(), run.job, run.startedAt, new Date(), run.ok, JSON.stringify(run.detail), run.lastSeq ?? null, run.s3Key ?? null, run.sizeBytes ?? null],
  );
}
