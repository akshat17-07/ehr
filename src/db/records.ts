import { AppError } from '../middleware/errors.js';
import type { Queryable } from './migrate.js';
import { historyTable } from './table.js';
import { withTransaction } from './transaction.js';

// Edits (api-list.md "Edits"): every PATCH sends the `version` it read. If someone saved first, 409 conflict.
// The old row goes to the history table (<table>_versions) in the same transaction, so no edit is lost.

const NAME = /^[a-z][a-z0-9_]*$/;
// 40001: DSQL found another transaction changed the row first (optimistic concurrency); same meaning as a stale version.
const CONFLICT_CODES = new Set(['40001']);
const conflict = () => new AppError(409, 'conflict', 'someone else saved this record first');

export interface RecordUpdate {
  id: string;
  /** The version the user read. */
  version: number;
  /** Who is saving (user id). */
  by: string;
  /** Columns to change (snake_case) and their new values. */
  set: Record<string, unknown>;
  /** Why it was changed (kept with the old row). */
  reason?: string;
}

function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Bad name: ${name}`);
  return name;
}

/** Saves an edit if `version` is still the latest; returns the new row (version + 1). 404 / 409 otherwise. The old row is kept. */
export async function updateRecord(db: Queryable, table: string, change: RecordUpdate): Promise<Record<string, unknown>> {
  checkName(table);
  const columns = Object.keys(change.set).map(checkName);
  if (columns.some((c) => ['id', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by'].includes(c))) {
    throw new Error('Base fields are set by updateRecord, not by the caller');
  }

  try {
    return await withTransaction(db, async (tx) => {
      const { rows } = await tx.query(`SELECT * FROM ${table} WHERE id = $1`, [change.id]);
      const current = rows[0];
      if (!current) throw new AppError(404, 'not_found');
      if (current.version !== change.version) throw conflict();

      try {
        await tx.query(
          `INSERT INTO ${historyTable(table)} (record_id, version, data, replaced_by, reason) VALUES ($1, $2, $3, $4, $5)`,
          [change.id, change.version, JSON.stringify(current), change.by, change.reason ?? null],
        );
      } catch (error) {
        // 23505: another save already kept this version.
        if ((error as { code?: string }).code === '23505') throw conflict();
        throw error;
      }

      const values = columns.map((c) => change.set[c]);
      const assignments = columns.map((c, i) => `${c} = $${i + 4}`);
      // WHERE version = ... as well: if another save got in between, no row matches and nothing is changed.
      const updated = await tx.query(
        `UPDATE ${table} SET ${['version = version + 1', 'updated_at = now()', 'updated_by = $3', ...assignments].join(', ')}
         WHERE id = $1 AND version = $2 RETURNING *`,
        [change.id, change.version, change.by, ...values],
      );
      const row = updated.rows[0];
      if (!row) throw conflict();
      return row;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code && CONFLICT_CODES.has(code)) throw conflict();
    throw error;
  }
}

export interface Version<T> {
  version: number;
  at: string;
  by: string;
  reason?: string;
  data: T;
}

// History keeps rows as JSON, where timestamps become text; columns named *_at are made Dates again, as the table gives them.
const reviveTimes = (key: string, value: unknown) =>
  key.endsWith('_at') && typeof value === 'string' ? new Date(value) : value;

/** Every version of a record, oldest first, the current one last (api-list.md Versions<T>). 404 if there is no such record. */
export async function listVersions<T>(
  db: Queryable,
  table: string,
  id: string,
  map: (row: Record<string, unknown>) => T,
): Promise<Version<T>[]> {
  checkName(table);
  const current = (await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
  if (!current) throw new AppError(404, 'not_found');
  const { rows } = await db.query(
    `SELECT version, data, reason FROM ${historyTable(table)} WHERE record_id = $1 ORDER BY version`,
    [id],
  );

  const all = [...rows.map((r) => JSON.parse(String(r.data), reviveTimes) as Record<string, unknown>), current];
  // The reason kept with version N's old row is why version N + 1 was made.
  const reasonFor = new Map(rows.map((r) => [Number(r.version) + 1, r.reason === null ? undefined : String(r.reason)]));
  return all.map((row) => {
    const version = Number(row.version);
    const reason = reasonFor.get(version);
    return {
      version,
      at: (row.updated_at as Date).toISOString(),
      by: String(row.updated_by),
      ...(reason !== undefined && { reason }),
      data: map(row),
    };
  });
}
