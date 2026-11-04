import { describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { appendAudit } from '../src/audit/log.js';
import { encryptForBackup } from '../src/backup/encrypt.js';
import { env } from '../src/config/env.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { auditExport } from '../src/jobs/audit-export.js';
import { runJob } from '../src/jobs/index.js';

// 4 Nov 2026 20:00 UTC = 5 Nov 01:30 India time.
const NOW = new Date('2026-11-04T20:00:00Z');
type Db = Awaited<ReturnType<typeof openLocalDb>>;

const add = (db: Db) => appendAudit(db, { userId: 'dev-admin', role: 'admin', action: 'view', recordType: 'test', ip: '1.1.1.1', device: 'test' });
async function setup(rows: number) {
  const db = await openLocalDb();
  await seedDev(db);
  for (let i = 0; i < rows; i++) await add(db);
  return db;
}
const identity = await generateX25519Identity();
const recipient = await identityToRecipient(identity);
const fakeFiles = () => {
  const puts: { key: string; body: Uint8Array }[] = [];
  return { puts, files: { put: async (key: string, body: Uint8Array) => void puts.push({ key, body }) } };
};
async function open(body: Uint8Array) {
  const d = new Decrypter();
  d.addIdentity(identity);
  return gunzipSync(await d.decrypt(body, 'uint8array'))
    .toString('utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
const runs = async (db: Db) => (await db.query('SELECT *, last_seq::text AS ls FROM job_runs ORDER BY started_at, id')).rows;
const total = async (db: Db) => Number((await db.query('SELECT count(*)::int AS n FROM audit_events')).rows[0]!.n);
const alerts = async (db: Db, sub: string) => (await db.query("SELECT * FROM alerts WHERE user_id = $1 AND kind = 'audit'", [sub])).rows;
const seqs = (lines: Record<string, unknown>[]) => lines.map((l) => Number(l.seq));
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

function config(stage = 'dev', withConfig = true) {
  env.STAGE = stage;
  env.BACKUP_AGE_RECIPIENT = withConfig ? recipient : undefined;
}

describe('audit_export job', () => {
  it('exports every row, encrypted, and records the run', async () => {
    config();
    const db = await setup(5);
    const n = await total(db);
    const { puts, files } = fakeFiles();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await auditExport({ db, now: NOW, backupFiles: files });
    const out = log.mock.calls.map((c) => String(c[0])).join('\n');
    log.mockRestore();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toBe(`audit/dev/2026/11/05/1-${n}.ndjson.gz.age`);
    const lines = await open(puts[0]!.body);
    expect(seqs(lines)).toEqual(upTo(n));
    expect(lines[0]).toMatchObject({ prev_hash: '0'.repeat(64) });
    expect(lines[n - 1]!.hash).toMatch(/^[0-9a-f]{64}$/);
    const [run] = await runs(db);
    expect(run).toMatchObject({ job: 'audit_export', ok: true, ls: String(n), s3_key: puts[0]!.key });
    expect(Number(run!.size_bytes)).toBe(puts[0]!.body.length);
    expect(out).toContain('"job":"audit_export"');
    expect(out).not.toContain('dev-admin');
  });

  it('second run uploads nothing; new rows go in the next file', async () => {
    config();
    const db = await setup(3);
    const n = await total(db);
    const { puts, files } = fakeFiles();
    await auditExport({ db, now: NOW, backupFiles: files });
    await auditExport({ db, now: NOW, backupFiles: files });
    expect(puts).toHaveLength(1);
    expect(await runs(db)).toHaveLength(2);
    await add(db);
    await add(db);
    await auditExport({ db, now: NOW, backupFiles: files });
    expect(puts).toHaveLength(2);
    expect(puts[1]!.key).toMatch(new RegExp(`/${n + 1}-${n + 2}\\.ndjson\\.gz\\.age$`));
    expect(seqs(await open(puts[1]!.body))).toEqual([n + 1, n + 2]);
  });

  it('a failed put throws, records nothing as exported, and the next run retries the range', async () => {
    config();
    const db = await setup(3);
    const n = await total(db);
    const bad = {
      put: async () => {
        throw new Error('S3 down');
      },
    };
    await expect(auditExport({ db, now: NOW, backupFiles: bad })).rejects.toThrow('S3 down');
    expect(await runs(db)).toEqual([expect.objectContaining({ ok: false, s3_key: null, last_seq: null })]);
    const { puts, files } = fakeFiles();
    await auditExport({ db, now: NOW, backupFiles: files });
    expect(puts[0]!.key).toContain(`/1-${n}.`);
  });

  it('pages through more than 1000 rows in order', async () => {
    config();
    const db = await setup(1010);
    const n = await total(db);
    const { puts, files } = fakeFiles();
    await auditExport({ db, now: NOW, backupFiles: files });
    expect(seqs(await open(puts[0]!.body))).toEqual(upTo(n));
  }, 120_000);

  it('a broken chain alerts audit.review users only, still exports, then fails the run', async () => {
    config();
    const db = await setup(4);
    await db.query("UPDATE audit_events SET reason = 'tampered' WHERE seq = 3");
    const { puts, files } = fakeFiles();
    await expect(auditExport({ db, now: NOW, backupFiles: files })).rejects.toThrow('Audit chain broken at entry 3: row was changed');
    expect(puts).toHaveLength(1);
    const [run] = await runs(db);
    expect(run).toMatchObject({ ok: false, s3_key: puts[0]!.key });
    expect(await alerts(db, 'dev-admin')).toEqual([
      expect.objectContaining({ title: 'Audit log check failed', body: 'Audit chain broken at entry 3: row was changed', link: '/admin/audit' }),
    ]);
    expect(await alerts(db, 'dev-nurse')).toHaveLength(0);
    // Same break again: no duplicate alert.
    await expect(auditExport({ db, now: NOW, backupFiles: files })).rejects.toThrow('Audit chain broken');
    expect(await alerts(db, 'dev-admin')).toHaveLength(1);
  });

  it('without backup config: non-prod checks the chain and skips; prod throws', async () => {
    const db = await setup(2);
    const { puts, files } = fakeFiles();
    config('dev', false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await auditExport({ db, now: NOW, backupFiles: files });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(puts).toHaveLength(0);
    expect(await runs(db)).toEqual([expect.objectContaining({ ok: true, s3_key: null, detail: '{"skipped":"no backup config"}' })]);
    await db.query("UPDATE audit_events SET reason = 'x' WHERE seq = 2");
    await expect(auditExport({ db, now: NOW, backupFiles: files })).rejects.toThrow('Audit chain broken');
    expect(await alerts(db, 'dev-admin')).toHaveLength(1);
    config('prod', false);
    await expect(auditExport({ db, now: NOW, backupFiles: files })).rejects.toThrow('not configured');
    config();
  });

  it('is wired into runJob; the others are still not built', async () => {
    config();
    const db = await setup(1);
    const { puts, files } = fakeFiles();
    await expect(runJob({ job: 'audit_export' }, { db, now: NOW, backupFiles: files })).resolves.toEqual({ job: 'audit_export', ok: true });
    expect(puts).toHaveLength(1);
    await expect(runJob({ job: 'pcpndt_monthly' }, { db })).rejects.toThrow('not built yet');
  });
});

describe('encryptForBackup', () => {
  it('round-trips with the matching identity', async () => {
    const sealed = await encryptForBackup(new TextEncoder().encode('hello backup'), recipient);
    expect(Buffer.from(sealed).includes(Buffer.from('hello backup'))).toBe(false);
    const d = new Decrypter();
    d.addIdentity(identity);
    expect(await d.decrypt(sealed, 'text')).toBe('hello backup');
  });

  it('rejects a bad recipient', async () => {
    await expect(encryptForBackup(new Uint8Array(1), 'age1short')).rejects.toThrow('not a valid age recipient');
  });
});
