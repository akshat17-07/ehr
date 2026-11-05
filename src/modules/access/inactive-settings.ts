import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';
import { STAFF_TYPES, type StaffType } from '../../permissions/defaults.js';

// The inactive-patient rule per role or user (api-list.md InactiveSetting, #185, #186). A patient with no activity for
// `days` is opened only with an approved access request or break-glass, unless the mode is any_record (no limit).
// With no setting for the user or their role, DEFAULT_INACTIVE_SETTING applies. A user's own setting beats their role's.
// Settings are never removed: replacing the list ends the old row (status ended) and keeps its history.

export const INACTIVE_MODES = ['any_record', 'request_after_days'] as const;
export const APPROVERS = ['head_doctor', 'admin'] as const;
export const SETTING_ROLES = STAFF_TYPES;

export interface InactiveRule {
  mode: (typeof INACTIVE_MODES)[number];
  days: number;
  approver: (typeof APPROVERS)[number];
  accessHours: number;
}

export const DEFAULT_INACTIVE_SETTING: InactiveRule = { mode: 'request_after_days', days: 10, approver: 'head_doctor', accessHours: 24 };

export interface InactiveSetting extends InactiveRule {
  appliesTo: 'role' | 'user';
  role?: StaffType;
  /** users.id */
  userId?: string;
}

export interface StoredInactiveSetting extends InactiveSetting {
  id: string;
  version: number;
}

function toSetting(r: Record<string, unknown>): StoredInactiveSetting {
  return {
    id: String(r.id),
    version: Number(r.version),
    appliesTo: r.applies_to as InactiveSetting['appliesTo'],
    ...(r.role != null && { role: r.role as StaffType }),
    ...(r.user_id != null && { userId: String(r.user_id) }),
    mode: r.mode as InactiveRule['mode'],
    days: Number(r.days),
    approver: r.approver as InactiveRule['approver'],
    accessHours: Number(r.access_hours),
  };
}

const keyOf = (s: InactiveSetting) => (s.appliesTo === 'role' ? `role:${s.role}` : `user:${s.userId}`);

/** #185: the settings in force, roles first, then users. */
export async function listInactiveSettings(db: Queryable): Promise<StoredInactiveSetting[]> {
  const { rows } = await db.query("SELECT * FROM inactive_settings WHERE status = 'active' ORDER BY applies_to, role, created_at, id");
  return rows.map(toSetting);
}

/**
 * The version of the whole list: it goes up whenever any setting is added, edited or ended (every row version
 * is at least 1 and each change adds to the sum), so a stale PATCH can be told apart. 0 when nothing was ever set.
 */
export async function inactiveSettingsVersion(db: Queryable): Promise<number> {
  const { rows } = await db.query('SELECT COALESCE(SUM(version), 0) AS v FROM inactive_settings');
  return Number(rows[0]?.v ?? 0);
}

/** #186: the list is replaced as a whole. Unchanged rows stay, changed ones are edited (history kept), missing ones end. */
export async function replaceInactiveSettings(
  db: Queryable,
  settings: InactiveSetting[],
  by: string,
  reason?: string,
  version?: number,
): Promise<StoredInactiveSetting[]> {
  const keys = settings.map(keyOf);
  if (new Set(keys).size !== keys.length) throw new AppError(422, 'invalid_input', 'settings: each role or user can have one setting');
  for (const s of settings) {
    if (s.appliesTo === 'user') {
      const { rows } = await db.query('SELECT 1 FROM users WHERE id = $1', [s.userId]);
      if (!rows[0]) throw new AppError(422, 'invalid_input', `userId ${s.userId}: no such user`);
    }
  }
  await withTransaction(db, async (tx) => {
    if (version !== undefined && (await inactiveSettingsVersion(tx)) !== version) {
      throw new AppError(409, 'stale_version', 'the inactive-access settings were changed by someone else');
    }
    const current = new Map((await listInactiveSettings(tx)).map((s) => [keyOf(s), s]));
    for (const s of settings) {
      const old = current.get(keyOf(s));
      current.delete(keyOf(s));
      if (!old) {
        await tx.query(
          `INSERT INTO inactive_settings (id, status, created_by, updated_by, applies_to, role, user_id, mode, days, approver, access_hours)
           VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), by, s.appliesTo, s.role ?? null, s.userId ?? null, s.mode, s.days, s.approver, s.accessHours],
        );
      } else if (old.mode !== s.mode || old.days !== s.days || old.approver !== s.approver || old.accessHours !== s.accessHours) {
        await updateRecord(tx, 'inactive_settings', {
          id: old.id, version: old.version, by, reason,
          set: { mode: s.mode, days: s.days, approver: s.approver, access_hours: s.accessHours },
        });
      }
    }
    for (const old of current.values()) {
      await updateRecord(tx, 'inactive_settings', { id: old.id, version: old.version, by, reason, set: { status: 'ended' } });
    }
  });
  return listInactiveSettings(db);
}

/**
 * What applies to this person: their own setting, else their types' (the strictest if several: a limit beats
 * any_record, then fewest days), else the default. `sub` is the Cognito sub.
 */
export async function ruleFor(db: Queryable, sub: string, types: readonly string[]): Promise<InactiveRule> {
  const roles = types.map((_, i) => `$${i + 2}`);
  const { rows } = await db.query(
    `SELECT s.* FROM inactive_settings s WHERE s.status = 'active'
       AND (s.user_id = (SELECT id FROM users WHERE cognito_sub = $1)${roles.length > 0 ? ` OR s.role IN (${roles.join(', ')})` : ''})`,
    [sub, ...types],
  );
  const found = rows.map(toSetting);
  const strictest = <T extends InactiveRule>(a: T, b: T): T =>
    a.mode !== b.mode ? (a.mode === 'request_after_days' ? a : b) : a.days <= b.days ? a : b;
  const own = found.find((s) => s.appliesTo === 'user');
  if (own) return own;
  const byRole = found.filter((s) => s.appliesTo === 'role');
  return byRole.length > 0 ? byRole.reduce(strictest) : DEFAULT_INACTIVE_SETTING;
}

/** The rule for a user looked up by their Cognito sub (their type comes from the users table). */
export async function ruleForSub(db: Queryable, sub: string): Promise<InactiveRule> {
  const { rows } = await db.query('SELECT type FROM users WHERE cognito_sub = $1', [sub]);
  return ruleFor(db, sub, rows[0] ? [String(rows[0].type)] : []);
}

/**
 * The days after which a patient shows as inactive: the shortest limit anyone has (settings that ask for a request,
 * and the default). It is a badge; whether a caller may open the record uses their own rule (patient-access.ts), and
 * a patient who is not inactive here is open to everyone.
 */
export async function displayInactiveDays(db: Queryable): Promise<number> {
  const { rows } = await db.query("SELECT MIN(days) AS days FROM inactive_settings WHERE status = 'active' AND mode = 'request_after_days'");
  const shortest = rows[0]?.days == null ? DEFAULT_INACTIVE_SETTING.days : Number(rows[0].days);
  return Math.min(shortest, DEFAULT_INACTIVE_SETTING.days);
}

