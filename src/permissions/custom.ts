import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/migrate.js';
import { updateRecord } from '../db/records.js';
import { AppError } from '../middleware/errors.js';
import { isPermission, type Permission } from './catalog.js';
import { GRANT_ONLY } from './defaults.js';

// user_permissions: a staff member's own extra permissions (allow) and removed ones (deny), set with #307,
// and their bundles (#157). All three are JSON arrays; bundles is empty (NULL) until first set.
// A user without a row has none (version 0). Every change keeps the old row (user_permissions_versions).

export interface CustomPermissions {
  /** 0 until the first change. */
  version: number;
  allow: Permission[];
  deny: Permission[];
  /** Bundle names. */
  bundles: string[];
}

export interface CustomChange {
  userId: string;
  /** The version the editor read (0 for a user with no custom permissions yet). */
  version: number;
  allow: string[];
  deny: string[];
  /** Who is saving. */
  by: string;
  reason: string;
}

const parse = (text: unknown) => JSON.parse(String(text)) as Permission[];

export async function getCustomPermissions(db: Queryable, userId: string): Promise<CustomPermissions> {
  const { rows } = await db.query('SELECT version, allow, deny, bundles FROM user_permissions WHERE user_id = $1', [userId]);
  const row = rows[0];
  if (!row) return { version: 0, allow: [], deny: [], bundles: [] };
  return {
    version: Number(row.version),
    allow: parse(row.allow),
    deny: parse(row.deny),
    bundles: row.bundles === null ? [] : (JSON.parse(String(row.bundles)) as string[]),
  };
}

/** Checks a change: known keys only, none in both lists, no grant-only permission in allow. Returns the lists sorted, once each. */
export function checkCustomLists(allow: string[], deny: string[]): { allow: Permission[]; deny: Permission[] } {
  const issues: { path: string; message: string }[] = [];
  for (const [list, keys] of [['allow', allow], ['deny', deny]] as const) {
    for (const key of keys) if (!isPermission(key)) issues.push({ path: list, message: `unknown permission: ${key}` });
  }
  for (const key of allow) {
    if (deny.includes(key)) issues.push({ path: 'allow', message: `${key} is in both allow and deny` });
    if (GRANT_ONLY.includes(key as Permission)) issues.push({ path: 'allow', message: `${key} is given only with a grant` });
  }
  if (issues.length) throw new AppError(422, 'invalid_input', issues.map((i) => i.message).join('; '));
  const tidy = (keys: string[]) => [...new Set(keys)].sort() as Permission[];
  return { allow: tidy(allow), deny: tidy(deny) };
}

/** Saves a user's custom permissions if `version` is still the latest (409 otherwise). */
export async function saveCustomPermissions(db: Queryable, change: CustomChange): Promise<CustomPermissions> {
  const { allow, deny } = checkCustomLists(change.allow, change.deny);
  return saveRow(db, change, { allow: JSON.stringify(allow), deny: JSON.stringify(deny) });
}

export interface BundlesChange {
  userId: string;
  /** As in CustomChange. */
  version: number;
  /** Names of bundles that exist (the caller checks). */
  bundles: string[];
  by: string;
  reason: string;
}

/** Saves a user's bundles (#157) if `version` is still the latest (409 otherwise). */
export async function saveBundles(db: Queryable, change: BundlesChange): Promise<CustomPermissions> {
  return saveRow(db, change, { bundles: JSON.stringify([...new Set(change.bundles)].sort()) });
}

const stale = () => new AppError(409, 'conflict', 'someone else saved this record first');

/** Writes the user's row: a new one for version 0, else an update with the version check. */
async function saveRow(
  db: Queryable,
  change: { userId: string; version: number; by: string; reason: string },
  set: { allow?: string; deny?: string; bundles?: string },
): Promise<CustomPermissions> {
  if (change.version === 0) {
    try {
      await db.query(
        `INSERT INTO user_permissions (id, status, created_by, updated_by, user_id, allow, deny, bundles)
         VALUES ($1, 'active', $2, $2, $3, $4, $5, $6)`,
        [randomUUID(), change.by, change.userId, set.allow ?? '[]', set.deny ?? '[]', set.bundles ?? null],
      );
    } catch (error) {
      // 23505: the user already has a row, so version 0 is stale.
      if ((error as { code?: string }).code === '23505') throw stale();
      throw error;
    }
  } else {
    const { rows } = await db.query('SELECT id FROM user_permissions WHERE user_id = $1', [change.userId]);
    if (!rows[0]) throw stale();
    await updateRecord(db, 'user_permissions', { id: String(rows[0].id), version: change.version, by: change.by, set, reason: change.reason });
  }
  return getCustomPermissions(db, change.userId);
}
