import { randomUUID } from 'node:crypto';
import type { openLocalDb } from '../src/db/local.js';

// Test helper: a job_runs row `hAgo` hours before 5 Nov 2026 02:00 UTC.
const NOW = new Date('2026-11-05T02:00:00Z');
type Db = Awaited<ReturnType<typeof openLocalDb>>;

export async function addRun(db: Db, job: string, hAgo: number, o: { ok?: boolean; key?: string | null; size?: number | null } = {}) {
  const at = new Date(NOW.getTime() - hAgo * 3_600_000);
  await db.query(
    `INSERT INTO job_runs (id, status, created_by, updated_by, created_at, job, started_at, finished_at, ok, detail, s3_key, size_bytes)
     VALUES ($1, 'done', 't', 't', $2, $3, $2, $2, $4, '{}', $5, $6)`,
    [randomUUID(), at, job, o.ok ?? true, o.key === undefined ? `k/${job}/${hAgo}` : o.key, o.size === undefined ? 1234 : o.size],
  );
}
