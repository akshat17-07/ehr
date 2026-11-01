import type { Context } from 'hono';
import type { Queryable } from '../db/migrate.js';
import { signGetUrl, type SignGetUrl } from '../files/signed-url.js';
import { cognitoStaffAccounts, type StaffAccounts } from '../identity/staff-accounts.js';
import type { AuthEnv, CurrentUser } from './auth.js';
import { AppError } from './errors.js';

// What every route reads from the request: the database (set by createApp) and the caller (set by requireUser).

export async function dbOf(c: Context<AuthEnv>): Promise<Queryable> {
  const db = c.get('db');
  if (!db) throw new Error('No database on the request (createApp sets it)');
  return db();
}

export function signerOf(c: Context<AuthEnv>): SignGetUrl {
  return c.get('signGetUrl') ?? signGetUrl;
}

export function accountsOf(c: Context<AuthEnv>): StaffAccounts {
  return c.get('staffAccounts') ?? cognitoStaffAccounts;
}

export function userOf(c: Context<AuthEnv>): CurrentUser {
  const user = c.get('user');
  if (!user) throw new AppError(401, 'unauthenticated');
  return user;
}
