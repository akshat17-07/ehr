import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Queryable } from '../db/migrate.js';
import type { AuthEnv } from '../middleware/auth.js';
import { dbOf, userOf } from '../middleware/context.js';
import { AppError } from '../middleware/errors.js';
import { bundlesNamed } from './bundles.js';
import type { Permission } from './catalog.js';
import { getCustomPermissions } from './custom.js';
import { STAFF_TYPES, type StaffType } from './defaults.js';
import { activeGrants, type Grant, type GrantScope } from './grants.js';
import { permissionsOfTypes } from './type-permissions.js';

// The permission check (api-list.md section 3): type permissions + bundles + custom allow + active grants − custom deny.
// requirePermission() guards an endpoint and counts only grants for "all". A grant for one department or patient
// counts only through assertPermission(), once the route knows which department or patient it touches.

export interface UserPermissions {
  userId: string;
  /** 0 until the user's custom permissions or bundles are first changed. */
  version: number;
  type?: StaffType;
  fromType: Permission[];
  fromBundles: { bundle: string; permissions: Permission[] }[];
  custom: { allow: Permission[]; deny: Permission[] };
  grants: Grant[];
  /** Everything the user may do anywhere (grants for one department or patient are not in here). */
  effective: Permission[];
}

/** type + bundles + custom allow + grants for "all" − custom deny. */
export function effectiveOf(
  parts: Pick<UserPermissions, 'fromBundles' | 'custom' | 'grants'> & { fromType: Iterable<Permission> },
): Set<Permission> {
  const effective = new Set<Permission>([
    ...parts.fromType,
    ...parts.fromBundles.flatMap((b) => b.permissions),
    ...parts.custom.allow,
    ...parts.grants.filter((g) => g.scope === 'all').map((g) => g.permission),
  ]);
  for (const p of parts.custom.deny) effective.delete(p);
  return effective;
}

/** Works out where each of a user's permissions comes from (#306), and the result. */
export async function loadPermissions(db: Queryable, userId: string, groups: readonly string[], now = new Date()): Promise<UserPermissions> {
  const types = STAFF_TYPES.filter((t) => groups.includes(t));
  const [fromType, custom, grants] = await Promise.all([
    permissionsOfTypes(db, types),
    getCustomPermissions(db, userId),
    activeGrants(db, userId, now),
  ]);
  const bundles = await bundlesNamed(db, custom.bundles);
  const fromBundles = bundles.map((b) => ({ bundle: b.name, permissions: b.permissions }));
  const effective = effectiveOf({ fromType, fromBundles, custom, grants });

  return {
    userId,
    version: custom.version,
    ...(types[0] && { type: types[0] }),
    fromType: [...fromType].sort(),
    fromBundles,
    custom: { allow: custom.allow, deny: custom.deny },
    grants,
    effective: [...effective].sort(),
  };
}

/** The caller's permissions, loaded once per request. */
export async function permissionsOf(c: Context<AuthEnv>): Promise<UserPermissions> {
  const cached = c.get('permissions');
  if (cached) return cached;
  const user = userOf(c);
  const loaded = await loadPermissions(await dbOf(c), user.sub, user.pool === 'staff' ? user.groups : []);
  c.set('permissions', loaded);
  return loaded;
}

const forbidden = (permission: Permission) => new AppError(403, 'forbidden', `needs ${permission}`);

/** Guards an endpoint: 403 unless the caller has `permission` everywhere. */
export const requirePermission = (permission: Permission) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    if (!(await permissionsOf(c)).effective.includes(permission)) throw forbidden(permission);
    await next();
  });

/** One line of GET /staff/me/permissions (api-list.md Permissions). */
export interface PermissionEntry {
  permission: Permission;
  scope: GrantScope;
  scopeId?: string;
  /** End of a grant. */
  until?: string;
  /** built_in = from the staff type or the user's own custom allow list. */
  source: 'built_in' | 'bundle' | 'grant';
}

/**
 * Everything the user may do, as the screen needs it to hide buttons: one "all" line per permission, then one line
 * per active grant (scoped ones too, with their patient or department). Custom denies are left out everywhere.
 */
export function permissionList(perms: UserPermissions): PermissionEntry[] {
  const deny = new Set(perms.custom.deny);
  const own = new Set([...perms.fromType, ...perms.custom.allow]);
  const fromBundles = new Set(perms.fromBundles.flatMap((b) => b.permissions));
  const always = [...new Set([...own, ...fromBundles])].filter((p) => !deny.has(p)).sort();
  return [
    ...always.map((permission): PermissionEntry => ({ permission, scope: 'all', source: own.has(permission) ? 'built_in' : 'bundle' })),
    ...perms.grants
      .filter((g) => !deny.has(g.permission))
      .map((g): PermissionEntry => ({
        permission: g.permission,
        scope: g.scope,
        ...(g.scopeId !== undefined && { scopeId: g.scopeId }),
        until: g.end,
        source: 'grant',
      })),
  ];
}

export interface PermissionTarget {
  patientId?: string;
  departmentIds?: string[];
}

/** For a route that knows its patient / departments: also counts grants for that patient or department. */
export async function assertPermission(c: Context<AuthEnv>, permission: Permission, target: PermissionTarget): Promise<void> {
  const perms = await permissionsOf(c);
  if (perms.effective.includes(permission)) return;
  if (perms.custom.deny.includes(permission)) throw forbidden(permission);
  const scoped = perms.grants.some(
    (g) =>
      g.permission === permission &&
      ((g.scope === 'patient' && g.scopeId === target.patientId) ||
        (g.scope === 'department' && g.scopeId !== undefined && (target.departmentIds ?? []).includes(g.scopeId))),
  );
  if (!scoped) throw forbidden(permission);
}

/**
 * Active staff whose effective permissions include `permission` (same sum as requirePermission: type + bundles + custom
 * allow + grants for "all" minus custom deny), as Cognito subs, which is how alerts and permissions key users. For jobs
 * that raise alerts with no signed-in caller.
 */
export async function usersWithPermission(db: Queryable, permission: Permission, now = new Date()): Promise<string[]> {
  const { rows } = await db.query('SELECT cognito_sub, type FROM users WHERE active = true AND voided_at IS NULL ORDER BY created_at, id');
  const found: string[] = [];
  for (const r of rows) {
    const perms = await loadPermissions(db, String(r.cognito_sub), [String(r.type)], now);
    if (perms.effective.includes(permission)) found.push(String(r.cognito_sub));
  }
  return found;
}
