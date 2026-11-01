import type { Context } from 'hono';
import type { Queryable } from '../db/migrate.js';
import type { AuthEnv, CurrentUser } from './auth.js';
import { AppError } from './errors.js';

// What every route reads from the request: the database (set by createApp) and the caller (set by requireUser).

export async function dbOf(c: Context<AuthEnv>): Promise<Queryable> {
  const db = c.get('db');
  if (!db) throw new Error('No database on the request (createApp sets it)');
  return db();
}

export function userOf(c: Context<AuthEnv>): CurrentUser {
  const user = c.get('user');
  if (!user) throw new AppError(401, 'unauthenticated');
  return user;
}
