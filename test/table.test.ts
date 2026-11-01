import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import { migrations } from '../src/db/migrations.js';
import { APPEND_ONLY_TABLES, appendOnlyTable, BASE_COLUMNS, baseFields, createTable, grantApp, type BaseRow } from '../src/db/table.js';

const ctx = { apiRoleArn: 'arn:aws:iam::1:role/api' };
const allStatements = migrations.flatMap((m) => m.statements(ctx).map((sql) => ({ id: m.id, sql })));

describe('createTable', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
    for (const sql of createTable('sample', ['name text NOT NULL'])) await db.query(sql);
  });
  afterAll(() => db.close());

  it('puts the base columns first', async () => {
    const { rows } = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'sample' ORDER BY ordinal_position",
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'id', 'version', 'status', 'created_at', 'created_by', 'updated_at', 'updated_by',
      'voided_at', 'voided_by', 'void_reason', 'name',
    ]);
  });

  it('lets the API read, add and change rows, but not delete them', async () => {
    const { rows } = await db.query(
      "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'sample' AND grantee = 'ehr_app' ORDER BY 1",
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });

  it('turns a row into API fields (void fields only when voided)', async () => {
    await db.query("INSERT INTO sample (id, status, created_by, updated_by, name) VALUES ($1, 'active', 'u1', 'u1', 'x')", [
      '00000000-0000-4000-8000-000000000001',
    ]);
    const { rows } = await db.query('SELECT * FROM sample');
    const fields = baseFields(rows[0] as unknown as BaseRow);
    expect(fields).toMatchObject({ id: '00000000-0000-4000-8000-000000000001', version: 1, status: 'active', createdBy: 'u1' });
    expect(fields).not.toHaveProperty('voidedAt');
  });

  it('append-only tables: read and add only, and only for listed tables', async () => {
    const { rows } = await db.query(
      "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'audit_events' AND grantee = 'ehr_app' ORDER BY 1",
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
    expect(() => appendOnlyTable('patients', [])).toThrow('not in APPEND_ONLY_TABLES');
  });

  it('refuses odd table names', () => {
    expect(() => createTable('x; DROP TABLE y', [])).toThrow('Bad table name');
  });
});

// Rules every migration must follow; this fails the build when one breaks them.
describe('migration rules', () => {
  it('never deletes data or grants DELETE', () => {
    for (const { id, sql } of allStatements) {
      expect(sql, id).not.toMatch(/\bDELETE\b|\bDROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)\b|\bTRUNCATE\b/i);
    }
  });

  it('gives every table the base columns and the ehr_app grant (use createTable)', () => {
    for (const { id, sql } of allStatements) {
      const table = /^CREATE TABLE (?:IF NOT EXISTS )?([a-z0-9_]+)/i.exec(sql)?.[1];
      if (!table || table === 'schema_migrations') continue;
      if (APPEND_ONLY_TABLES.includes(table)) {
        expect(allStatements.map((s) => s.sql), `${id}: ${table} grant`).toContain(appendOnlyTable(table, [])[1]);
        continue;
      }
      expect(sql, `${id}: ${table} base columns`).toContain(`(${BASE_COLUMNS.join(', ')}`);
      expect(allStatements.map((s) => s.sql), `${id}: ${table} grant`).toContain(grantApp(table));
    }
  });

  it('uses CREATE INDEX ASYNC (DSQL builds indexes in the background)', () => {
    for (const { id, sql } of allStatements) {
      if (/\bCREATE (UNIQUE )?INDEX\b/i.test(sql)) expect(sql, id).toMatch(/\bINDEX ASYNC\b/i);
    }
  });

  it('has unique ids in order', () => {
    const ids = migrations.map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
