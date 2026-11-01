import { createHash, randomUUID } from 'node:crypto';
import type { Queryable } from '../db/migrate.js';

// The audit log (api-list.md AuditEvent): one row per request or change, append-only, hash chained.
// Each row stores sha256(its own fields + the previous row's hash), so editing or removing any row
// breaks every hash after it. `seq` is the primary key: two writers can't both add row N, so the chain never forks.

export const AUDIT_ACTIONS = ['view', 'create', 'update', 'void', 'print', 'download', 'export', 'login', 'grant', 'denied'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Hash before the first row. */
export const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  userId: string;
  role: string;
  action: AuditAction;
  patientId?: string;
  recordType?: string;
  recordId?: string;
  /** Changed fields: { field: [old, new] }. */
  changes?: Record<string, [unknown, unknown]>;
  reason?: string;
  ip: string;
  device: string;
}

export interface AuditEvent extends AuditInput {
  seq: number;
  id: string;
  at: string;
  prevHash: string;
  hash: string;
}

/** The hash of one row: every field in a fixed order, then the previous hash. */
export function auditHash(e: Omit<AuditEvent, 'hash'>): string {
  const fields = [
    e.seq, e.id, e.at, e.userId, e.role, e.action, e.patientId ?? null, e.recordType ?? null,
    e.recordId ?? null, e.changes ?? null, e.reason ?? null, e.ip, e.device, e.prevHash,
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

// 23505 = someone else added that seq first; 40001 = DSQL optimistic-concurrency conflict. Both: read the end again.
const RETRY_CODES = new Set(['23505', '40001']);
const MAX_TRIES = 10;

/** Adds one event at the end of the chain and returns it. */
export async function appendAudit(db: Queryable, input: AuditInput): Promise<AuditEvent> {
  for (let attempt = 1; ; attempt++) {
    // ORDER BY the bigint column, not the text copy (as text, '9' sorts after '10').
    const { rows } = await db.query('SELECT seq::text AS seq_text, hash FROM audit_events ORDER BY audit_events.seq DESC LIMIT 1');
    const last = rows[0];
    const unhashed = {
      ...input,
      seq: last ? Number(last.seq_text) + 1 : 1,
      id: randomUUID(),
      at: new Date().toISOString(),
      prevHash: last ? String(last.hash) : GENESIS_HASH,
    };
    const event: AuditEvent = { ...unhashed, hash: auditHash(unhashed) };
    try {
      await db.query(
        `INSERT INTO audit_events (seq, id, at, user_id, role, action, patient_id, record_type, record_id, changes, reason, ip, device, prev_hash, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          event.seq, event.id, event.at, event.userId, event.role, event.action, event.patientId ?? null,
          event.recordType ?? null, event.recordId ?? null, event.changes ? JSON.stringify(event.changes) : null,
          event.reason ?? null, event.ip, event.device, event.prevHash, event.hash,
        ],
      );
      return event;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!code || !RETRY_CODES.has(code) || attempt >= MAX_TRIES) throw error;
    }
  }
}

function fromRow(r: Record<string, unknown>): AuditEvent {
  const opt = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
  return {
    seq: Number(r.seq_text),
    id: String(r.id),
    at: (r.at as Date).toISOString(),
    userId: String(r.user_id),
    role: String(r.role),
    action: r.action as AuditAction,
    patientId: opt(r.patient_id),
    recordType: opt(r.record_type),
    recordId: opt(r.record_id),
    changes: r.changes === null ? undefined : JSON.parse(String(r.changes)),
    reason: opt(r.reason),
    ip: String(r.ip),
    device: String(r.device),
    prevHash: String(r.prev_hash),
    hash: String(r.hash),
  };
}

export type ChainCheck = { ok: true; checked: number } | { ok: false; checked: number; brokenAt: number; problem: string };

/** Recomputes every hash in order. Reports the first row that was changed, removed or put out of order. */
export async function verifyAuditChain(db: Queryable): Promise<ChainCheck> {
  const { rows } = await db.query(
    'SELECT seq::text AS seq_text, id::text AS id, at, user_id, role, action, patient_id::text AS patient_id, record_type, record_id, changes, reason, ip, device, prev_hash, hash FROM audit_events ORDER BY audit_events.seq',
  );
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    const e = fromRow(row);
    const { hash, ...rest } = e;
    if (e.seq !== expectedSeq) return { ok: false, checked: expectedSeq - 1, brokenAt: expectedSeq, problem: 'missing row' };
    if (e.prevHash !== prev) return { ok: false, checked: e.seq - 1, brokenAt: e.seq, problem: 'previous hash does not match' };
    if (auditHash(rest) !== hash) return { ok: false, checked: e.seq - 1, brokenAt: e.seq, problem: 'row was changed' };
    prev = hash;
    expectedSeq++;
  }
  return { ok: true, checked: rows.length };
}
