import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_ROLE_ARN, openLocalDb, type LocalDb } from '../src/db/local.js';
import { migrate } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';

// Every real migration, run against real Postgres (in memory).
describe('local database', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
  });
  afterAll(() => db.close());

  it('applies every migration', async () => {
    const { rows } = await db.query('SELECT id FROM schema_migrations ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(migrations.map((m) => m.id));
  });

  it('has nothing left to apply the second time', async () => {
    expect(await migrate(db, { apiRoleArn: LOCAL_ROLE_ARN, dialect: 'postgres' })).toEqual([]);
  });

  it('creates the ehr_app login role', async () => {
    const { rows } = await db.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = 'ehr_app'");
    expect(rows).toEqual([{ rolcanlogin: true }]);
  });
});

describe('local database on disk (npm run dev)', () => {
  it('creates missing folders and keeps data between runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ehr-db-'));
    const dir = join(root, '.data', 'db');
    try {
      const first = await openLocalDb(dir);
      await first.query('CREATE TABLE kept (id text)');
      await first.query("INSERT INTO kept VALUES ('x')");
      await first.close();

      const second = await openLocalDb(dir);
      expect((await second.query('SELECT id FROM kept')).rows).toEqual([{ id: 'x' }]);
      await second.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // Two opens on disk run every migration twice (~100 migrations); with the whole suite running alongside, that
    // can pass 30 s.
  }, 120_000);
});
