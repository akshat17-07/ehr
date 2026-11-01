import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';

// In-app alerts for one staff member (api-list.md Alert): e.g. a break-glass on a patient, an expiring licence.
// Only in the app: no email or SMS. Low stock is never an alert (reorder is worked out when asked, #287).

export const ALERT_KINDS = ['rx_check', 'expiry', 'recall', 'claim_timer', 'approval', 'backup', 'licence', 'breakglass'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface Alert {
  id: string;
  kind: AlertKind;
  title: string;
  body: string;
  link?: string;
  createdAt: string;
  readAt?: string;
}

export interface NewAlert {
  userId: string;
  kind: AlertKind;
  title: string;
  body: string;
  /** A path in the app, e.g. /patients/<id>. */
  link?: string;
  /** Who or what raised it (a user id or a job name). */
  by: string;
}

export const toAlert = (r: Record<string, unknown>): Alert => ({
  id: String(r.id),
  kind: r.kind as AlertKind,
  title: String(r.title),
  body: String(r.body),
  ...(r.link != null && { link: String(r.link) }),
  createdAt: (r.created_at as Date).toISOString(),
  ...(r.read_at != null && { readAt: (r.read_at as Date).toISOString() }),
});

/** Raises an alert for one user. */
export async function createAlert(db: Queryable, alert: NewAlert): Promise<Alert> {
  const { rows } = await db.query(
    `INSERT INTO alerts (id, status, created_by, updated_by, user_id, kind, title, body, link)
     VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [randomUUID(), alert.by, alert.userId, alert.kind, alert.title, alert.body, alert.link ?? null],
  );
  return toAlert(rows[0] as Record<string, unknown>);
}

/** A user's alerts, newest first; `unread` keeps only the ones not yet read. */
export function listAlerts(db: Queryable, userId: string, query: PageQuery & { unread?: boolean }): Promise<Page<Alert>> {
  const where = ['user_id = $1'];
  if (query.unread === true) where.push('read_at IS NULL');
  if (query.unread === false) where.push('read_at IS NOT NULL');
  return pageRows(db, { select: 'SELECT * FROM alerts', where, params: [userId], orderBy: ['created_at', 'id'] }, query, toAlert);
}
