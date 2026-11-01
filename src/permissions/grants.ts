import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/migrate.js';
import { updateRecord } from '../db/records.js';
import { AppError } from '../middleware/errors.js';
import { isPermission, type Permission } from './catalog.js';

// grants: a permission given to one user for a limited time (api-list.md Grant), e.g. pcpndt.write for a month.
// Rows are never removed: revoking sets status `revoked` with a reason; after `end` a grant reads as `expired`.
// Whether the grantor may give it (their grant rule, their own permissions) is checked by the endpoint (#171).

export const GRANT_SCOPES = ['all', 'department', 'patient'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

/** Grant rules can't hold role.* or user.* (#168), so no grant can either. */
const NEVER_GRANTED = /^(role|user)\./;
const MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Grant {
  id: string;
  version: number;
  userId: string;
  permission: Permission;
  scope: GrantScope;
  scopeId?: string;
  start: string;
  end: string;
  grantorId: string;
  reason: string;
  status: 'active' | 'expired' | 'revoked';
}

export interface NewGrant {
  userId: string;
  permission: string;
  scope: GrantScope;
  scopeId?: string;
  /** Default: now. */
  start?: Date;
  end: Date;
  grantorId: string;
  reason: string;
}

function fromRow(row: Record<string, unknown>, now: Date): Grant {
  const end = row.ends_at as Date;
  const stored = String(row.status);
  return {
    id: String(row.id),
    version: Number(row.version),
    userId: String(row.user_id),
    permission: row.permission as Permission,
    scope: row.scope as GrantScope,
    ...(row.scope_id !== null && { scopeId: String(row.scope_id) }),
    start: (row.starts_at as Date).toISOString(),
    end: end.toISOString(),
    grantorId: String(row.grantor_id),
    reason: String(row.reason),
    status: stored === 'revoked' ? 'revoked' : end <= now ? 'expired' : 'active',
  };
}

function invalid(message: string): never {
  throw new AppError(422, 'invalid_input', message);
}

export async function createGrant(db: Queryable, grant: NewGrant, now = new Date()): Promise<Grant> {
  const start = grant.start ?? now;
  if (!isPermission(grant.permission)) invalid(`unknown permission: ${grant.permission}`);
  if (NEVER_GRANTED.test(grant.permission)) invalid(`${grant.permission} can't be granted`);
  if (grant.userId === grant.grantorId) invalid('nobody can grant to themselves');
  if (!GRANT_SCOPES.includes(grant.scope)) invalid(`unknown scope: ${grant.scope}`);
  if ((grant.scope === 'all') !== (grant.scopeId === undefined)) invalid('scopeId is needed for department and patient scope only');
  if (grant.end <= start) invalid('end must be after start');
  if (grant.end <= now) invalid('end must be in the future');
  if (grant.end.getTime() - start.getTime() > MAX_DAYS * DAY_MS) invalid(`a grant can last ${MAX_DAYS} days at most`);
  if (!grant.reason.trim()) invalid('a reason is needed');

  const { rows } = await db.query(
    `INSERT INTO grants (id, status, created_by, updated_by, user_id, permission, scope, scope_id, starts_at, ends_at, grantor_id, reason)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $2, $9) RETURNING *`,
    [randomUUID(), grant.grantorId, grant.userId, grant.permission, grant.scope, grant.scopeId ?? null, start, grant.end, grant.reason],
  );
  return fromRow(rows[0] as Record<string, unknown>, now);
}

/** Ends a grant now. 409 if it was already revoked or the version is stale. */
export async function revokeGrant(
  db: Queryable,
  change: { id: string; version: number; by: string; reason: string },
  now = new Date(),
): Promise<Grant> {
  const { rows } = await db.query('SELECT status FROM grants WHERE id = $1', [change.id]);
  if (!rows[0]) throw new AppError(404, 'not_found');
  if (rows[0].status === 'revoked') throw new AppError(409, 'conflict', 'this grant is already revoked');
  const row = await updateRecord(db, 'grants', { ...change, set: { status: 'revoked' } });
  return fromRow(row, now);
}

/** A user's grants that count right now: not revoked, started, not ended. */
export async function activeGrants(db: Queryable, userId: string, now = new Date()): Promise<Grant[]> {
  const { rows } = await db.query(
    "SELECT * FROM grants WHERE user_id = $1 AND status = 'active' AND starts_at <= $2 AND ends_at > $2 ORDER BY ends_at",
    [userId, now],
  );
  return rows.map((r) => fromRow(r, now));
}
