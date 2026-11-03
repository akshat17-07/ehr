import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { env } from '../src/config/env.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { backupExport, encodeValue } from '../src/jobs/backup-export.js';
import { runJob } from '../src/jobs/index.js';

// 4 Nov 2026 20:00 UTC = 5 Nov 01:00 India time (the UTC date is a day earlier).
const NOW = new Date('2026-11-04T20:00:00Z');
type Db = Awaited<ReturnType<typeof openLocalDb>>;

const identity = await generateX25519Identity();
const recipient = await identityToRecipient(identity);
const config = (stage = 'dev', withConfig = true) => {
  env.STAGE = stage;
  env.BACKUP_AGE_RECIPIENT = withConfig ? recipient : undefined;
};
const fakeFiles = (failOn?: number) => {
  const puts: { key: string; body: Uint8Array }[] = [];
  return {
    puts,
    files: {
      put: async (key: string, body: Uint8Array) => {
        if (failOn !== undefined && puts.length + 1 === failOn) throw new Error('S3 down');
        puts.push({ key, body });
      },
    },
  };
};
const decrypt = async (body: Uint8Array) => {
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(body, 'uint8array');
};
const lines = async (body: Uint8Array) =>
  gunzipSync(await decrypt(body)).toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
const runs = async (db: Db) => (await db.query('SELECT * FROM job_runs ORDER BY started_at, id')).rows;
const setup = async () => {
  const db = await openLocalDb();
  await seedDev(db);
  return db;
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Manifest = { runId: string; stage: string; tables: { name: string; rows: number; parts: { key: string; rows: number; sizeBytes: number; sha256: string }[] }[] };
const manifestOf = async (puts: { key: string; body: Uint8Array }[]) => JSON.parse(Buffer.from(await decrypt(puts[puts.length - 1]!.body)).toString('utf8')) as Manifest;

describe('backup_export job', () => {
  it('exports every table, encrypted, with a manifest written last', async () => {
    config();
    const db = await setup();
    const { puts, files } = fakeFiles();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await backupExport({ db, now: NOW, backupFiles: files });
    log.mockRestore();

    const tableNames = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")).rows.map((r) => String(r.table_name));
    const manifest = await manifestOf(puts);
    expect(manifest.tables.map((t) => t.name)).toEqual(tableNames);
    expect(tableNames).toEqual(expect.arrayContaining(['audit_events', 'schema_migrations', 'users', 'job_runs']));
    expect(puts[puts.length - 1]!.key).toMatch(/\/manifest\.json\.age$/);
    expect(puts.filter((p) => p.key.endsWith('manifest.json.age'))).toHaveLength(1);

    // Every part: sha256 and size of the encrypted bytes match; rows add up to the table.
    const byKey = new Map(puts.map((p) => [p.key, p.body]));
    for (const t of manifest.tables.filter((x) => x.name !== 'job_runs')) {
      const count = Number((await db.query(`SELECT count(*)::int AS n FROM "${t.name}"`)).rows[0]!.n);
      expect(t.rows).toBe(count);
      expect(t.parts.reduce((n, p) => n + p.rows, 0)).toBe(count);
      for (const p of t.parts) {
        expect(sha(byKey.get(p.key)!)).toBe(p.sha256);
        expect(byKey.get(p.key)!.length).toBe(p.sizeBytes);
      }
    }

    // Rows match the database.
    const users = manifest.tables.find((t) => t.name === 'users')!;
    const exported = await lines(byKey.get(users.parts[0]!.key)!);
    const live = (await db.query('SELECT id::text AS id, cognito_sub, name, created_at, reg_valid_till::text AS reg_valid_till FROM users ORDER BY id')).rows;
    expect(exported.map((r) => r.id)).toEqual(live.map((r) => r.id));
    expect(exported[0]).toMatchObject({ cognito_sub: live[0]!.cognito_sub, name: live[0]!.name, created_at: (live[0]!.created_at as Date).toISOString(), reg_valid_till: live[0]!.reg_valid_till });

    // job_runs.
    const [run] = await runs(db);
    expect(run).toMatchObject({ job: 'backup_export', ok: true, s3_key: puts[puts.length - 1]!.key });
    expect(Number(run!.size_bytes)).toBe(puts.reduce((n, p) => n + p.body.length, 0));
    expect(JSON.parse(String(run!.detail))).toMatchObject({ runId: manifest.runId, tables: tableNames.length });
  });

  it('keys carry the stage, India date and run id; two runs never share a key', async () => {
    config('staging');
    const db = await setup();
    const a = fakeFiles();
    const b = fakeFiles();
    await backupExport({ db, now: NOW, backupFiles: a.files });
    await backupExport({ db, now: NOW, backupFiles: b.files });
    const ma = await manifestOf(a.puts);
    const mb = await manifestOf(b.puts);
    expect(ma.runId).not.toBe(mb.runId);
    for (const p of a.puts) expect(p.key.startsWith(`backup/staging/2026/11/05/${ma.runId}/`)).toBe(true);
    const keys = new Set([...a.puts, ...b.puts].map((p) => p.key));
    expect(keys.size).toBe(a.puts.length + b.puts.length);
    config();
  });

  it('splits a table into parts and pages by id without repeating or missing a row', async () => {
    config();
    const db = await setup();
    for (let i = 0; i < 2300; i++) {
      await db.query(
        "INSERT INTO alerts (id, status, created_by, updated_by, user_id, kind, title, body, created_at) VALUES (gen_random_uuid(), 'active', 't', 't', 'bulk', 'audit', $1, 'b', '2026-01-01T00:00:00Z')",
        [`bulk ${i}`],
      );
    }
    const total = Number((await db.query('SELECT count(*)::int AS n FROM alerts')).rows[0]!.n);
    const { puts, files } = fakeFiles();
    await backupExport({ db, now: NOW, backupFiles: files }, 1000);
    const alerts = (await manifestOf(puts)).tables.find((t) => t.name === 'alerts')!;
    expect(alerts.parts.map((p) => p.rows)).toEqual([1000, 1000, total - 2000]);
    expect(alerts.parts.map((p) => p.key.split('/').pop())).toEqual(['0001.ndjson.gz.age', '0002.ndjson.gz.age', '0003.ndjson.gz.age']);
    const ids: string[] = [];
    for (const p of alerts.parts) ids.push(...(await lines(puts.find((x) => x.key === p.key)!.body)).map((r) => String(r.id)));
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(ids).toEqual([...ids].sort());
  }, 120_000);

  it('pages a history table by its composite primary key, each row exactly once in key order', async () => {
    config();
    const db = await setup();
    const ids = ['00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000c3'];
    for (const id of ids) {
      for (let v = 1; v <= 12; v++) {
        await db.query("INSERT INTO alerts_versions (record_id, version, data, replaced_by) VALUES ($1, $2, '{}', 't')", [id, v]);
      }
    }
    const { puts, files } = fakeFiles();
    await backupExport({ db, now: NOW, backupFiles: files }, 5000, 7);
    const hist = (await manifestOf(puts)).tables.find((t) => t.name === 'alerts_versions')!;
    expect(hist.rows).toBe(36);
    const rows: Record<string, unknown>[] = [];
    for (const p of hist.parts) rows.push(...(await lines(puts.find((x) => x.key === p.key)!.body)));
    const got = rows.map((r) => `${String(r.record_id)}/${String(r.version).padStart(2, '0')}`);
    expect(new Set(got).size).toBe(36);
    expect(got).toEqual([...got].sort());
  });

  it('encodes dates as ISO text and bytea as base64', () => {
    expect(encodeValue(new Date('2026-11-04T20:00:00Z'))).toBe('2026-11-04T20:00:00.000Z');
    expect(encodeValue(Buffer.from([1, 2, 255]))).toEqual({ $b64: 'AQL/' });
    expect(encodeValue('5')).toBe('5');
    expect(encodeValue(null)).toBeNull();
  });

  it('without config: non-prod skips; prod records a failure and throws; a bad recipient throws', async () => {
    const db = await setup();
    const { puts, files } = fakeFiles();
    config('dev', false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await backupExport({ db, now: NOW, backupFiles: files });
    warn.mockRestore();
    expect(puts).toHaveLength(0);
    expect(await runs(db)).toEqual([expect.objectContaining({ ok: true, s3_key: null, detail: '{"skipped":"no backup config"}' })]);

    config('prod', false);
    await expect(backupExport({ db, now: NOW, backupFiles: files })).rejects.toThrow('not configured');
    expect((await runs(db))[1]).toMatchObject({ ok: false, detail: '{"error":"no backup config"}' });

    config();
    env.BACKUP_AGE_RECIPIENT = 'age1bad';
    await expect(backupExport({ db, now: NOW, backupFiles: files })).rejects.toThrow('not a valid age recipient');
    expect((await runs(db))[2]).toMatchObject({ ok: false });
    expect(puts).toHaveLength(0);
    config();
  });

  it('a failed put throws, records ok=false and never writes a manifest', async () => {
    config();
    const db = await setup();
    const { puts, files } = fakeFiles(2);
    await expect(backupExport({ db, now: NOW, backupFiles: files })).rejects.toThrow('S3 down');
    expect(puts).toHaveLength(1);
    expect(puts.some((p) => p.key.endsWith('manifest.json.age'))).toBe(false);
    const [run] = await runs(db);
    expect(run).toMatchObject({ ok: false, s3_key: null, size_bytes: null });
    expect(JSON.parse(String(run!.detail))).toMatchObject({ error: 'S3 down', table: expect.any(String), runId: expect.any(String) });
  });

  it('runs through runJob', async () => {
    config();
    const db = await setup();
    const { puts, files } = fakeFiles();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runJob({ job: 'backup_export' }, { db, now: NOW, backupFiles: files })).resolves.toEqual({ job: 'backup_export', ok: true });
    log.mockRestore();
    expect(puts[puts.length - 1]!.key).toMatch(/manifest\.json\.age$/);
  });
});
