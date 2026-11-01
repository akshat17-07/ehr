import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { appendAudit, type AuditAction, type AuditInput } from '../audit/log.js';
import type { Queryable } from '../db/migrate.js';
import type { AuthEnv } from './auth.js';

/** What a route adds to its audit row: the patient and record it touched, field changes, a reason, or a special action. */
export type AuditDetails = Partial<Pick<AuditInput, 'action' | 'patientId' | 'recordType' | 'recordId' | 'changes' | 'reason'>>;

/** Called by a route to fill in its audit row (several calls merge). */
export function auditDetails(c: Context<AuthEnv>, details: AuditDetails): void {
  c.set('audit', { ...c.get('audit'), ...details });
}

const MAX_DEVICE_LENGTH = 200;

function defaultAction(method: string, status: number): AuditAction {
  if (status === 401 || status === 403) return 'denied';
  if (method === 'GET' || method === 'HEAD') return 'view';
  if (method === 'POST') return 'create';
  return 'update';
}

function sourceIp(c: Context<AuthEnv>): string {
  const http = (c.env?.event?.requestContext as { http?: { sourceIp?: string } } | undefined)?.http;
  return http?.sourceIp ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

/**
 * Writes one hash-chained audit row for every request, reads included (api-list.md "Audit"):
 * who (user + role), what (action + record, or the method and path), which patient, IP and device.
 * Refused requests (401/403) are logged as `denied`. The query string is never logged (searches can hold names).
 * If the row can't be written the caller gets 500 instead of the data: no access without an audit row.
 */
export const auditRequests = (db: () => Promise<Queryable>) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    await next();
    const user = c.get('user');
    const details = c.get('audit') ?? {};
    const status = c.res.status;
    const denied = status === 401 || status === 403;
    const event: AuditInput = {
      userId: user?.sub ?? 'anonymous',
      // Groups first: a staff token sent to a patient route still shows its staff role.
      role: user ? user.groups.join(',') || (user.pool === 'patient' ? 'patient' : 'none') : 'anonymous',
      action: denied ? 'denied' : (details.action ?? defaultAction(c.req.method, status)),
      patientId: details.patientId,
      recordType: details.recordType ?? 'endpoint',
      recordId: details.recordId ?? `${c.req.method} ${c.req.path}`,
      changes: details.changes,
      reason: details.reason,
      ip: sourceIp(c),
      device: (c.req.header('user-agent') ?? 'unknown').slice(0, MAX_DEVICE_LENGTH),
    };
    try {
      await appendAudit(await db(), event);
    } catch (error) {
      console.error(JSON.stringify({ msg: 'audit write failed', path: c.req.path, error: String(error) }));
      c.res = c.json({ error: 'server_error' }, 500);
    }
  });
