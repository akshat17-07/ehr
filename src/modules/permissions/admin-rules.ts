import type { Queryable } from '../../db/migrate.js';
import type { CurrentUser } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errors.js';
import { PERMISSIONS, type Permission } from '../../permissions/catalog.js';
import { effectiveOf, loadPermissions } from '../../permissions/check.js';

// The limits on changing permissions (api-list.md section 4, "Custom permissions"):
//   - nobody changes their own permissions;
//   - a Head Doctor can't change an Admin, the Admin type, or give an Admin-only permission;
//   - 409 last_admin if no active Admin would keep every user.* permission.

/** Every user.* permission: the ones needed to run the accounts. */
export const USER_POWERS: Permission[] = PERMISSIONS.filter((p) => p.key.startsWith('user.')).map((p) => p.key);
const ADMIN_ONLY = new Set<string>(PERMISSIONS.filter((p) => p.adminOnly).map((p) => p.key));

export const isAdmin = (caller: CurrentUser) => caller.groups.includes('admin');

const refuse = (message: string) => new AppError(403, 'forbidden', message);

/** For #307 and #157: may `caller` change the permissions of a user of `targetType`? */
export function assertMayChangeUser(caller: CurrentUser, target: { sub: string; type: string }): void {
  if (caller.sub === target.sub) throw refuse('nobody changes their own permissions');
  if (!isAdmin(caller) && target.type === 'admin') throw refuse("only an Admin changes an Admin's permissions");
}

/** For #307 and #309: a Head Doctor can't give Admin-only permissions. */
export function assertMayGive(caller: CurrentUser, permissions: readonly string[]): void {
  if (isAdmin(caller)) return;
  const adminOnly = permissions.filter((p) => ADMIN_ONLY.has(p));
  if (adminOnly.length > 0) throw refuse(`only an Admin gives: ${adminOnly.join(', ')}`);
}

/** What a change would be, for the last-admin check. Leave a part out if it does not change. */
export interface PermissionChange {
  /** New custom lists for one user (by sub). */
  custom?: { sub: string; allow: Permission[]; deny: Permission[] };
  /** New permissions of the admin type. */
  adminType?: Permission[];
  /** A user being deactivated (by sub). */
  deactivate?: string;
}

/** 409 last_admin unless, after `change`, at least one active Admin still has every user.* permission. */
export async function assertAdminRemains(db: Queryable, change: PermissionChange, now = new Date()): Promise<void> {
  const { rows } = await db.query("SELECT cognito_sub FROM users WHERE type = 'admin' AND active");
  for (const sub of rows.map((r) => String(r.cognito_sub))) {
    if (sub === change.deactivate) continue;
    const perms = await loadPermissions(db, sub, ['admin'], now);
    const custom = change.custom?.sub === sub ? change.custom : perms.custom;
    const effective = effectiveOf({ ...perms, fromType: change.adminType ?? perms.fromType, custom });
    if (USER_POWERS.every((p) => effective.has(p))) return;
  }
  throw new AppError(409, 'last_admin', 'at least one active Admin must keep every user.* permission');
}
