import type { Queryable } from '../../db/migrate.js';
import type { CurrentUser } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errors.js';
import { createGrant, grantForAdmin, revokeGrant, type Grant, type GrantScope } from '../../permissions/grants.js';
import { checkDepartments, getUser, UUID } from '../users/users.js';
import { assertMayChangeUser, assertMayGive, isAdmin } from './admin-rules.js';
import { listGrantRules } from './grant-rules.js';

// #171: who may give a grant (api-list.md section 4). An Admin may give any permission a grant can hold.
// A Head Doctor needs an active grant rule that lists the permission, covers the scope (a department rule covers
// only grants for that department) and is at least as long, and must hold the permission themselves.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GrantRequest {
  /** users.id */
  userId: string;
  permission: string;
  scope: GrantScope;
  scopeId?: string;
  start?: Date;
  end: Date;
  reason: string;
}

const refuse = (message: string) => new AppError(403, 'forbidden', message);
const invalid = (message: string) => new AppError(422, 'invalid_input', message);

async function checkScopeId(db: Queryable, scope: GrantScope, scopeId: string | undefined): Promise<void> {
  if (scope === 'department' && scopeId) await checkDepartments(db, [scopeId]);
  if (scope === 'patient' && scopeId) {
    const { rows } = await db.query('SELECT merged_into FROM patients WHERE id = $1', [scopeId]);
    if (!rows[0]) throw invalid('no such patient');
    if (rows[0].merged_into !== null) throw invalid('that patient was merged; use the patient it was merged into');
  }
}

export async function giveGrant(
  db: Queryable,
  caller: CurrentUser,
  callerPermissions: readonly string[],
  input: GrantRequest,
  now = new Date(),
): Promise<Grant> {
  const user = await getUser(db, input.userId).catch(() => {
    throw invalid('no such user');
  });
  if (!user.active) throw invalid('that user is not active');
  assertMayChangeUser(caller, { sub: user.cognitoSub, type: user.type });
  assertMayGive(caller, [input.permission]);
  await checkScopeId(db, input.scope, input.scopeId);

  if (!isAdmin(caller)) {
    if (!callerPermissions.includes(input.permission)) throw refuse(`you don't have ${input.permission} yourself`);
    const { rows } = await db.query('SELECT id FROM users WHERE cognito_sub = $1', [caller.sub]);
    const rules = rows[0] ? await listGrantRules(db, String(rows[0].id)) : [];
    const days = (input.end.getTime() - (input.start ?? now).getTime()) / DAY_MS;
    const fits = rules.some(
      (r) =>
        r.active &&
        r.mayGrant.includes(input.permission as never) &&
        (r.scope === 'all' || (input.scope === 'department' && input.scopeId === r.departmentId)) &&
        days <= r.maxDays,
    );
    if (!fits) throw refuse('outside your grant rules');
  }

  const grant = await createGrant(db, { ...input, userId: user.cognitoSub, grantorId: caller.sub }, now);
  return grantForAdmin(db, grant.id, now);
}

/**
 * #172: ends a grant now, with the reason kept in its history. An Admin revokes any grant; a Head Doctor only the
 * ones they gave. 409 if it was already revoked or has ended.
 */
export async function takeBackGrant(db: Queryable, caller: CurrentUser, id: string, reason: string, now = new Date()): Promise<Grant> {
  const { rows } = UUID.test(id) ? await db.query('SELECT version, status, grantor_id, ends_at FROM grants WHERE id = $1', [id]) : { rows: [] };
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found');
  if (!isAdmin(caller) && row.grantor_id !== caller.sub) throw refuse('a Head Doctor takes back only the grants they gave');
  if (row.status !== 'revoked' && (row.ends_at as Date) <= now) throw new AppError(409, 'conflict', 'this grant has already ended');
  await revokeGrant(db, { id, version: Number(row.version), by: caller.sub, reason }, now);
  return grantForAdmin(db, id, now);
}
