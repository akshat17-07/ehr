import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, GENESIS_HASH, verifyAuditChain, type AuditInput } from '../src/audit/log.js';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import type { Queryable } from '../src/db/migrate.js';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const view: AuditInput = { userId: 'u-doc', role: 'doctor', action: 'view', patientId: PATIENT, ip: '10.0.0.5', device: 'Firefox' };

describe('audit log', () => {
  let db: LocalDb;
  beforeEach(async () => {
    db = await openLocalDb();
  });
  afterEach(() => db.close());

  it('chains each event to the one before', async () => {
    const first = await appendAudit(db, view);
    const second = await appendAudit(db, {
      ...view,
      action: 'update',
      recordType: 'patient',
      recordId: PATIENT,
      changes: { mobile: ['9800000000', '9811111111'] },
      reason: 'patient asked',
    });
    expect(first).toMatchObject({ seq: 1, prevHash: GENESIS_HASH });
    expect(second).toMatchObject({ seq: 2, prevHash: first.hash });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 2 });
  });

  it('keeps counting past 10 (seq is ordered as a number)', async () => {
    for (let i = 0; i < 12; i++) await appendAudit(db, view);
    expect((await appendAudit(db, view)).seq).toBe(13);
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 13 });
  });

  it('an empty log is a valid chain', async () => {
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 0 });
  });

  // The API can't do these (no UPDATE/DELETE grant); this proves tampering by anyone else is still caught.
  it('finds a changed row', async () => {
    for (let i = 0; i < 3; i++) await appendAudit(db, view);
    await db.query("UPDATE audit_events SET user_id = 'someone-else' WHERE seq = 2");
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, brokenAt: 2, problem: 'row was changed' });
  });

  it('finds a removed row', async () => {
    for (let i = 0; i < 3; i++) await appendAudit(db, view);
    await db.query('DELETE FROM audit_events WHERE seq = 2');
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, brokenAt: 2, problem: 'missing row' });
  });

  it('finds a row rebuilt with a fresh hash (the next row no longer links to it)', async () => {
    for (let i = 0; i < 3; i++) await appendAudit(db, view);
    await db.query("UPDATE audit_events SET hash = repeat('a', 64) WHERE seq = 2");
    const check = await verifyAuditChain(db);
    expect(check).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('keeps the changes and optional fields exactly', async () => {
    await appendAudit(db, { ...view, action: 'update', changes: { name: ['Ram', 'Ram Kumar'] } });
    const { rows } = await db.query('SELECT changes, record_type FROM audit_events');
    expect(JSON.parse(String(rows[0]?.changes))).toEqual({ name: ['Ram', 'Ram Kumar'] });
    expect(rows[0]?.record_type).toBeNull();
  });

  it('retries when another request added the same seq first', async () => {
    await appendAudit(db, view);
    let conflicts = 1;
    const racing: Queryable = {
      async query(sql, params) {
        if (sql.trimStart().startsWith('INSERT') && conflicts-- > 0) {
          await appendAudit(db, view); // the other request wins seq 2
          throw Object.assign(new Error('duplicate key'), { code: '23505' });
        }
        return db.query(sql, params);
      },
    };
    expect(await appendAudit(racing, view)).toMatchObject({ seq: 3 });
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 3 });
  });

  it('does not retry other errors', async () => {
    const broken: Queryable = {
      async query(sql, params) {
        if (sql.trimStart().startsWith('INSERT')) throw Object.assign(new Error('disk full'), { code: '53100' });
        return db.query(sql, params);
      },
    };
    await expect(appendAudit(broken, view)).rejects.toThrow('disk full');
  });
});
