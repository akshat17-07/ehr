import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { AppError } from '../../middleware/errors.js';

// Security incidents (api-list.md Incident, #222-#224). CERT-In must hear within 6 h of detection, the Board within 72 h.
// Events are the timeline: they are only added, never changed or removed. A closed incident takes no events unless
// the same call reopens it.

export const INCIDENT_KINDS = ['breach', 'ransomware', 'phishing', 'loss', 'other'] as const;
export const INCIDENT_STATUSES = ['open', 'reported', 'closed'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

const HOUR = 3_600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Incident {
  id: string;
  version: number;
  status: IncidentStatus;
  title: string;
  detectedAt: string;
  kind: (typeof INCIDENT_KINDS)[number];
  description: string;
  certInDueBy: string;
  boardDueBy: string;
  events: { at: string; text: string; by: string }[];
}

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v as Date).toISOString();

async function withEvents(db: Queryable, rows: Row[]): Promise<Incident[]> {
  if (rows.length === 0) return [];
  const marks = rows.map((_, i) => `$${i + 1}`).join(', ');
  // The sub is stored; show the users.id when the person is a known user.
  const events = (
    await db.query(
      `SELECT e.incident_id, e.at, e.text, COALESCE(u.id::text, e."by") AS who FROM incident_events e
       LEFT JOIN users u ON u.cognito_sub = e."by" WHERE e.incident_id IN (${marks}) ORDER BY e.at, e.created_at, e.id`,
      rows.map((r) => r.id),
    )
  ).rows;
  return rows.map((r) => ({
    id: String(r.id),
    version: Number(r.version),
    status: r.status as IncidentStatus,
    title: String(r.title),
    detectedAt: iso(r.detected_at),
    kind: r.kind as Incident['kind'],
    description: String(r.description),
    certInDueBy: iso(r.cert_in_due_by),
    boardDueBy: iso(r.board_due_by),
    events: events
      .filter((e) => String(e.incident_id) === String(r.id))
      .map((e) => ({ at: iso(e.at), text: String(e.text), by: String(e.who) })),
  }));
}

/** #222: newest incident first, optionally one status. */
export async function listIncidents(db: Queryable, status?: IncidentStatus): Promise<Incident[]> {
  const { rows } = await db.query(
    `SELECT * FROM incidents ${status ? 'WHERE status = $1' : ''} ORDER BY detected_at DESC, id`,
    status ? [status] : [],
  );
  return withEvents(db, rows);
}

export interface NewIncident {
  title: string;
  detectedAt: string;
  kind: Incident['kind'];
  description: string;
}

/** #223: opens an incident; the CERT-In and Board deadlines follow from detectedAt. */
export async function addIncident(db: Queryable, input: NewIncident, by: string): Promise<Incident> {
  const detected = new Date(input.detectedAt);
  if (detected.getTime() > Date.now()) throw new AppError(422, 'invalid_input', 'detectedAt cannot be in the future');
  const { rows } = await db.query(
    `INSERT INTO incidents (id, status, created_by, updated_by, title, detected_at, kind, description, cert_in_due_by, board_due_by)
     VALUES ($1, 'open', $2, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [randomUUID(), by, input.title, detected, input.kind, input.description, new Date(detected.getTime() + 6 * HOUR), new Date(detected.getTime() + 72 * HOUR)],
  );
  return (await withEvents(db, rows))[0]!;
}

/** #224: adds a timeline entry, and moves the incident to `status` when given. */
export async function addIncidentEvent(
  db: Queryable,
  id: string,
  input: { text: string; status?: IncidentStatus },
  by: string,
): Promise<Incident> {
  if (!UUID.test(id)) throw new AppError(404, 'not_found');
  return withTransaction(db, async (tx) => {
    const current = (await tx.query('SELECT * FROM incidents WHERE id = $1', [id])).rows[0];
    if (!current) throw new AppError(404, 'not_found');
    if (current.status === 'closed' && input.status !== 'open') {
      throw new AppError(409, 'closed', 'this incident is closed; reopen it to add to it');
    }
    await tx.query(
      `INSERT INTO incident_events (id, status, created_by, updated_by, incident_id, at, text, "by") VALUES ($1, 'active', $2, $2, $3, now(), $4, $2)`,
      [randomUUID(), by, id, input.text],
    );
    let row: Row = current;
    if (input.status && input.status !== current.status) {
      row = await updateRecord(tx, 'incidents', { id, version: Number(current.version), by, set: { status: input.status } });
    }
    return (await withEvents(tx, [row]))[0]!;
  });
}
