import { describe, expect, it } from 'vitest';
import { migrate, type Queryable } from '../src/db/migrate.js';
import type { Migration } from '../src/db/migrations.js';

function fakeDb(applied: string[] = [], failWith?: { sql: string; code: string }) {
  const log: string[] = [];
  const db: Queryable = {
    async query(sql, params) {
      log.push(params ? `${sql} ${JSON.stringify(params)}` : sql);
      if (sql === 'SELECT id FROM schema_migrations') return { rows: applied.map((id) => ({ id })) };
      if (failWith && sql === failWith.sql) throw Object.assign(new Error('boom'), { code: failWith.code });
      return { rows: [] };
    },
  };
  return { db, log };
}

const migrations: Migration[] = [
  { id: '0001', statements: ({ apiRoleArn }) => ['CREATE ROLE ehr_app WITH LOGIN', `GRANT TO '${apiRoleArn}'`] },
  { id: '0002', statements: () => ['CREATE TABLE t (id text PRIMARY KEY)'] },
];
const ctx = { apiRoleArn: 'arn:aws:iam::1:role/ehr-dev-api' };

describe('migrate', () => {
  it('runs pending migrations in order and records them', async () => {
    const { db, log } = fakeDb();
    expect(await migrate(db, ctx, migrations)).toEqual(['0001', '0002']);
    expect(log.slice(2)).toEqual([
      'CREATE ROLE ehr_app WITH LOGIN',
      "GRANT TO 'arn:aws:iam::1:role/ehr-dev-api'",
      'INSERT INTO schema_migrations (id) VALUES ($1) ["0001"]',
      'CREATE TABLE t (id text PRIMARY KEY)',
      'INSERT INTO schema_migrations (id) VALUES ($1) ["0002"]',
    ]);
  });

  it('skips migrations that already ran', async () => {
    const { db } = fakeDb(['0001']);
    expect(await migrate(db, ctx, migrations)).toEqual(['0002']);
  });

  it('carries on when an object already exists (a half-finished run)', async () => {
    const { db } = fakeDb([], { sql: 'CREATE ROLE ehr_app WITH LOGIN', code: '42710' });
    expect(await migrate(db, ctx, migrations)).toEqual(['0001', '0002']);
  });

  it('stops on any other error and records nothing for that migration', async () => {
    const { db, log } = fakeDb([], { sql: 'CREATE ROLE ehr_app WITH LOGIN', code: '42501' });
    await expect(migrate(db, ctx, migrations)).rejects.toThrow('boom');
    expect(log.some((l) => l.startsWith('INSERT'))).toBe(false);
  });
});
