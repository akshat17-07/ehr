import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';

// Every error leaves the API in one shape: { error: <code>, message?: <text> }, plus `details` fields when given.
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500,
    readonly code: string,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export function onError(err: Error, c: Context) {
  if (err instanceof AppError) return c.json({ ...err.details, error: err.code, message: err.message }, err.status);
  if (err instanceof ZodError) return c.json({ error: 'invalid_input', issues: err.issues }, 422);
  if (err instanceof HTTPException) return c.json({ error: 'http_error', message: err.message }, err.status);

  console.error(err);
  return c.json({ error: 'server_error' }, 500);
}

export function onNotFound(c: Context) {
  return c.json({ error: 'not_found' }, 404);
}
