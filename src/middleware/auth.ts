import type { Context } from 'hono';
import type { LambdaEvent } from 'hono/aws-lambda';
import { createMiddleware } from 'hono/factory';
import { env } from '../config/env.js';
import type { Queryable } from '../db/migrate.js';
import type { SignGetUrl } from '../files/signed-url.js';
import type { FileUploads } from '../files/uploads.js';
import type { StaffAccounts } from '../identity/staff-accounts.js';
import type { UserPermissions } from '../permissions/check.js';
import type { AuditDetails } from './audit.js';
import { STAFF_TYPES } from '../permissions/defaults.js';
import { dbOf, userOf } from './context.js';
import { AppError } from './errors.js';

export type Pool = 'staff' | 'patient';

// Cognito groups allowed on each route prefix (see app.ts). Must match STAFF_GROUPS in infra/constructs/auth.ts.
export const WORKFORCE_GROUPS = ['admin', 'head_doctor', 'doctor', 'nurse', 'staff', 'medical'] as const;
export const MANAGEMENT_GROUPS = ['admin', 'head_doctor'] as const;
export const INSURANCE_GROUPS = ['insurance'] as const;
export const GP_GROUPS = ['gp'] as const;

export interface CurrentUser {
  sub: string;
  email: string;
  pool: Pool;
  groups: string[];
}

export type AuthEnv = {
  Bindings: { event?: LambdaEvent };
  Variables: {
    user?: CurrentUser;
    audit?: AuditDetails;
    /** The database, set by createApp for every request. */
    db?: () => Promise<Queryable>;
    /** The caller's permissions, loaded on the first check of the request. */
    permissions?: UserPermissions;
    /** Makes signed S3 download links, set by createApp. */
    signGetUrl?: SignGetUrl;
    /** Signs uploads and checks stored files, set by createApp. */
    uploads?: FileUploads;
    /** Cognito staff accounts, set by createApp. */
    staffAccounts?: StaffAccounts;
  };
};

type Claims = Record<string, unknown>;

/**
 * API Gateway's JWT authorizer has already checked the token's signature, expiry and audience
 * before the Lambda runs. This middleware only reads the claims it passes on and makes sure the
 * token came from the expected Cognito pool (staff tokens can't call patient routes, and back),
 * and, when `groups` is given, that the user is in at least one of them.
 * Per-endpoint permissions are checked after this, by the endpoint.
 */
export const requireUser = (pool: Pool, groups?: readonly string[]) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const claims = claimsFromEvent(c.env?.event) ?? devClaims(c.req.header('x-dev-user'));
    if (!claims || typeof claims.sub !== 'string') throw new AppError(401, 'unauthenticated');

    const userGroups = parseGroups(claims['cognito:groups']);
    // Set before the checks below, so a refused request is still audited under the real user.
    c.set('user', {
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : '',
      pool,
      groups: userGroups,
    });

    const expectedPoolId = pool === 'staff' ? env.STAFF_POOL_ID : env.PATIENT_POOL_ID;
    const issuer = typeof claims.iss === 'string' ? claims.iss : '';
    if (expectedPoolId && !issuer.endsWith(`/${expectedPoolId}`)) throw new AppError(403, 'wrong_pool');

    if (pool === 'staff') await checkStaffRecord(c);
    const current = c.get('user')?.groups ?? userGroups;
    if (groups && !current.some((g) => groups.includes(g))) throw new AppError(403, 'wrong_group');
    await next();
  });

/**
 * A staff member with a users row is refused once deactivated (401 account_disabled), and their type is the row's,
 * not the token's: the ID token lives up to an hour, so a deactivation or a promotion must not wait for it.
 * Without a row (the first Admin, made in the console) the token's groups are used.
 */
async function checkStaffRecord(c: Context<AuthEnv>): Promise<void> {
  const user = userOf(c);
  const db = await dbOf(c);
  const { rows } = await db.query('SELECT type, active FROM users WHERE cognito_sub = $1', [user.sub]);
  const row = rows[0];
  if (!row) return;
  if (row.active !== true) throw new AppError(401, 'account_disabled', 'this account has been deactivated');
  const types: readonly string[] = STAFF_TYPES;
  c.set('user', { ...user, groups: [...user.groups.filter((g) => !types.includes(g)), String(row.type)] });
}

function claimsFromEvent(event: LambdaEvent | undefined): Claims | undefined {
  const ctx = event?.requestContext as { authorizer?: { jwt?: { claims?: Claims } } } | undefined;
  return ctx?.authorizer?.jwt?.claims;
}

// The HTTP API authorizer passes Cognito groups as the string "[admin doctor]".
export function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || raw === '') return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

// Local development only: header `x-dev-user: <sub>|<email>|<group1,group2>`.
function devClaims(header: string | undefined): Claims | undefined {
  if (env.NODE_ENV !== 'development' || !header) return undefined;
  const [sub, email, groups = ''] = header.split('|');
  return { sub, email, 'cognito:groups': groups.split(',').filter(Boolean) };
}
