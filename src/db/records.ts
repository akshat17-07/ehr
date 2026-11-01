import { AppError } from '../middleware/errors.js';
import type { Queryable } from './migrate.js';
import { withTransaction } from './transaction.js';

// Edits (api-list.md "Edits"): every PATCH sends the `version` it read. If someone saved first, 409 conflict.

const NAME = /^[a-z][a-z0-9_]*$/;
// 40001: DSQL found another transaction changed the row first (optimistic concurrency); same meaning as a stale version.
const CONFLICT_CODES = new Set(['40001']);

export interface RecordUpdate {
  id: string;
  /** The version the user read. */
  version: number;
  /** Who is saving (user id). */
  by: string;
  /** Columns to change (snake_case) and their new values. */
  set: Record<string, unknown>;
}

function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Bad name: ${name}`);
  return name;
}

/** Saves an edit if `version` is still the latest; returns the new row (version + 1). 404 / 409 otherwise. */
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
      if (current.version !== change.version) throw new AppError(409, 'conflict', 'someone else saved this record first');

      const values = columns.map((c) => change.set[c]);
      const assignments = columns.map((c, i) => `${c} = $${i + 4}`);
      // WHERE version = ... as well: if another save got in between, no row matches and nothing is changed.
      const updated = await tx.query(
        `UPDATE ${table} SET ${['version = version + 1', 'updated_at = now()', 'updated_by = $3', ...assignments].join(', ')}
         WHERE id = $1 AND version = $2 RETURNING *`,
        [change.id, change.version, change.by, ...values],
      );
      const row = updated.rows[0];
      if (!row) throw new AppError(409, 'conflict', 'someone else saved this record first');
      return row;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code && CONFLICT_CODES.has(code)) throw new AppError(409, 'conflict', 'someone else saved this record first');
    throw error;
  }
}
