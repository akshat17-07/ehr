import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { AppError } from '../../middleware/errors.js';
import { isPermission, PERMISSIONS, type Permission } from '../../permissions/catalog.js';
import { checkDepartments, UUID } from '../users/users.js';

// Grant rules: what a Head Doctor may grant, where and for how long (api-list.md GrantRule, section 4).
// An Admin sets them (#168/#169); a grant (#171) must fit one of the grantor's active rules.

export const GRANT_RULE_SCOPES = ['all', 'department'] as const;
export type GrantRuleScope = (typeof GRANT_RULE_SCOPES)[number];

export interface GrantRule {
  id: string;
  version: number;
  grantorUserId: string;
  mayGrant: Permission[];
  scope: GrantRuleScope;
  departmentId?: string;
  maxDays: number;
  active: boolean;
}

export function toGrantRule(row: Record<string, unknown>): GrantRule {
  return {
    id: String(row.id),
    version: Number(row.version),
    grantorUserId: String(row.grantor_id),
    mayGrant: JSON.parse(String(row.may_grant)) as Permission[],
    scope: row.scope as GrantRuleScope,
    ...(row.department_id !== null && { departmentId: String(row.department_id) }),
    maxDays: Number(row.max_days),
    active: row.status === 'active',
  };
}

/** #167: every rule (active first, then ended), oldest first; or one grantor's. */
export async function listGrantRules(db: Queryable, grantorUserId?: string): Promise<GrantRule[]> {
  if (grantorUserId !== undefined && !UUID.test(grantorUserId)) throw new AppError(422, 'invalid_input', 'grantorUserId must be a user id');
  const { rows } = await db.query(
    `SELECT * FROM grant_rules${grantorUserId ? ' WHERE grantor_id = $1' : ''} ORDER BY status = 'active' DESC, created_at, id`,
    grantorUserId ? [grantorUserId] : [],
  );
  return rows.map(toGrantRule);
}

const ADMIN_ONLY = new Set<string>(PERMISSIONS.filter((p) => p.adminOnly).map((p) => p.key));

function invalid(message: string): never {
  throw new AppError(422, 'invalid_input', message);
}

/** 422 for an unknown permission, role.* or user.* (#168), or one only an Admin may give. Sorted, without repeats. */
export function checkMayGrant(keys: readonly string[]): Permission[] {
  const issues = keys.flatMap((key) =>
    !isPermission(key)
      ? [`unknown permission: ${key}`]
      : /^(role|user)\./.test(key)
        ? [`${key} can't be granted`]
        : ADMIN_ONLY.has(key)
          ? [`only an Admin may give ${key}`]
          : [],
  );
  if (issues.length) invalid(issues.join('; '));
  return [...new Set(keys)].sort() as Permission[];
}

/** department scope needs an active department; all scope takes none. */
async function checkScope(db: Queryable, scope: GrantRuleScope, departmentId: string | undefined): Promise<void> {
  if (scope === 'all') {
    if (departmentId !== undefined) invalid('departmentId is only for department scope');
    return;
  }
  if (departmentId === undefined) invalid('department scope needs a departmentId');
  await checkDepartments(db, [departmentId]);
}

export interface NewGrantRule {
  grantorUserId: string;
  mayGrant: string[];
  scope: GrantRuleScope;
  departmentId?: string;
  maxDays: number;
}

async function checkGrantor(db: Queryable, grantorUserId: string): Promise<void> {
  const { rows } = await db.query('SELECT type, active FROM users WHERE id = $1', [grantorUserId]);
  if (rows[0]?.type !== 'head_doctor' || rows[0].active !== true) invalid('grantorUserId must be an active Head Doctor');
}

/** #168: 422 unless the grantor is an active Head Doctor (an Admin needs no rule). */
export async function addGrantRule(db: Queryable, input: NewGrantRule, by: string): Promise<GrantRule> {
  await checkGrantor(db, input.grantorUserId);
  const mayGrant = checkMayGrant(input.mayGrant);
  await checkScope(db, input.scope, input.departmentId);
  const { rows } = await db.query(
    `INSERT INTO grant_rules (id, status, created_by, updated_by, grantor_id, may_grant, scope, department_id, max_days)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [randomUUID(), by, input.grantorUserId, JSON.stringify(mayGrant), input.scope, input.departmentId ?? null, input.maxDays],
  );
  return toGrantRule(rows[0] as Record<string, unknown>);
}

/** #162: a Head Doctor who goes back to doctor keeps no rules. Ended rules stay, with the reason in their history. */
export async function endGrantRules(db: Queryable, grantorUserId: string, by: string, reason: string): Promise<void> {
  const { rows } = await db.query("SELECT id, version FROM grant_rules WHERE grantor_id = $1 AND status = 'active'", [grantorUserId]);
  for (const row of rows) {
    await updateRecord(db, 'grant_rules', { id: String(row.id), version: Number(row.version), by, set: { status: 'ended' }, reason });
  }
}

export interface GrantRuleChange {
  version: number;
  mayGrant?: string[];
  scope?: GrantRuleScope;
  departmentId?: string;
  maxDays?: number;
  active?: boolean;
  reason?: string;
}

/**
 * #169: 404 for no rule; 422 for nothing to change. Giving a scope or departmentId sets both (scope all drops the
 * department). Starting an ended rule again needs the grantor to still be an active Head Doctor.
 */
export async function changeGrantRule(db: Queryable, id: string, change: GrantRuleChange, by: string): Promise<GrantRule> {
  if (!UUID.test(id)) throw new AppError(404, 'not_found');
  const { rows } = await db.query('SELECT * FROM grant_rules WHERE id = $1', [id]);
  if (!rows[0]) throw new AppError(404, 'not_found');
  const rule = toGrantRule(rows[0] as Record<string, unknown>);
  const set: Record<string, unknown> = {};
  if (change.mayGrant) set.may_grant = JSON.stringify(checkMayGrant(change.mayGrant));
  if (change.scope !== undefined || change.departmentId !== undefined) {
    const scope = change.scope ?? rule.scope;
    await checkScope(db, scope, change.departmentId);
    set.scope = scope;
    set.department_id = change.departmentId ?? null;
  }
  if (change.maxDays !== undefined) set.max_days = change.maxDays;
  if (change.active !== undefined && change.active !== rule.active) {
    if (change.active) await checkGrantor(db, rule.grantorUserId);
    set.status = change.active ? 'active' : 'ended';
  }
  if (Object.keys(set).length === 0) invalid('nothing to change');
  return toGrantRule(await updateRecord(db, 'grant_rules', { id, version: change.version, by, set, ...(change.reason && { reason: change.reason }) }));
}
