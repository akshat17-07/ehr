import { randomUUID } from 'node:crypto';
import type { Queryable } from './migrate.js';

// Running numbers (UHIDs, "Unknown-<n>" names): DSQL has no sequences, so each count is a row in `counters`.
// Run nextCount on its own, not inside a transaction: a DSQL conflict (40001) then shows up here and is retried,
// not at a later COMMIT. A number taken by a request that fails afterwards is skipped, never given twice.

// 23505 = two requests added the first row at once; 40001 = DSQL optimistic-concurrency conflict.
const RETRY_CODES = new Set(['23505', '40001']);
const MAX_TRIES = 10;

/** The next number of counter `name`: 1, 2, 3 ... */
export async function nextCount(db: Queryable, name: string): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { rows } = await db.query(
        `UPDATE counters SET value = value + 1, version = version + 1, updated_at = now() WHERE name = $1
         RETURNING value::text AS value`,
        [name],
      );
      if (rows[0]) return Number(rows[0].value);
      await db.query(
        `INSERT INTO counters (id, status, created_by, updated_by, name, value) VALUES ($1, 'active', 'system', 'system', $2, 1)`,
        [randomUUID(), name],
      );
      return 1;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!code || !RETRY_CODES.has(code) || attempt >= MAX_TRIES) throw error;
    }
  }
}
