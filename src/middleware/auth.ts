import type { LambdaEvent } from 'hono/aws-lambda';
import { createMiddleware } from 'hono/factory';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

export type Pool = 'staff' | 'patient';

export interface CurrentUser {
  sub: string;
  email: string;
  pool: Pool;
  groups: string[];
}

export type AuthEnv = {
  Bindings: { event?: LambdaEvent };
  Variables: { user: CurrentUser };
};

type Claims = Record<string, unknown>;

/**
 * API Gateway's JWT authorizer has already checked the token's signature, expiry and audience
 * before the Lambda runs. This middleware only reads the claims it passes on and makes sure the
 * token came from the expected Cognito pool (staff tokens can't call patient routes, and back).
 */
export const requireUser = (pool: Pool) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const claims = claimsFromEvent(c.env?.event) ?? devClaims(c.req.header('x-dev-user'));
    if (!claims || typeof claims.sub !== 'string') throw new AppError(401, 'unauthenticated');

    const expectedPoolId = pool === 'staff' ? env.STAFF_POOL_ID : env.PATIENT_POOL_ID;
    const issuer = typeof claims.iss === 'string' ? claims.iss : '';
    if (expectedPoolId && !issuer.endsWith(`/${expectedPoolId}`)) throw new AppError(403, 'wrong_pool');

    c.set('user', {
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : '',
      pool,
      groups: parseGroups(claims['cognito:groups']),
    });
    await next();
  });

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
