import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import type { Permission } from '../../permissions/catalog.js';
import { UUID } from '../users/users.js';

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
