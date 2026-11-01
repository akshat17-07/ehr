import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import type { Queryable } from '../src/db/migrate.js';
import { listVersions, updateRecord } from '../src/db/records.js';
import { baseFields, createTable, type BaseRow } from '../src/db/table.js';
import { withTransaction } from '../src/db/transaction.js';

let n = 0;
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

describe('edits with a version check', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
    for (const sql of createTable('wards', ['name text NOT NULL', 'beds integer NOT NULL'])) await db.query(sql);
  });
  afterAll(() => db.close());

  async function addWard() {
    const id = newId();
    await db.query("INSERT INTO wards (id, status, created_by, updated_by, name, beds) VALUES ($1, 'active', 'u0', 'u0', 'A', 10)", [id]);
    return id;
  }

  it('saves the change and moves the version on', async () => {
    const id = await addWard();
    const row = await updateRecord(db, 'wards', { id, version: 1, by: 'u1', set: { beds: 12 } });
    expect(row).toMatchObject({ id, version: 2, beds: 12, name: 'A', updated_by: 'u1', created_by: 'u0' });
  });

  it('409 when someone saved first, and nothing is changed', async () => {
    const id = await addWard();
    await updateRecord(db, 'wards', { id, version: 1, by: 'u1', set: { beds: 12 } });
    await expect(updateRecord(db, 'wards', { id, version: 1, by: 'u2', set: { beds: 99 } })).rejects.toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect((await db.query('SELECT version, beds FROM wards WHERE id = $1', [id])).rows[0]).toEqual({ version: 2, beds: 12 });
  });

  it('409 when another save lands between the read and the write', async () => {
    const id = await addWard();
    // The other save happens just before our UPDATE runs.
    const racing: Queryable = {
      async query(sql, params) {
        if (sql.trimStart().startsWith('UPDATE')) await db.query('UPDATE wards SET version = 2 WHERE id = $1', [id]);
        return db.query(sql, params);
      },
    };
    await expect(updateRecord(racing, 'wards', { id, version: 1, by: 'u1', set: { beds: 1 } })).rejects.toMatchObject({ status: 409 });
  });

  it('409 when DSQL reports a write conflict at commit', async () => {
    const id = await addWard();
    const dsql: Queryable = {
      async query(sql, params) {
        if (sql === 'COMMIT') throw Object.assign(new Error('change conflicts with another transaction'), { code: '40001' });
        return sql === 'BEGIN' || sql === 'ROLLBACK' ? { rows: [] } : db.query(sql, params);
      },
    };
    await expect(updateRecord(dsql, 'wards', { id, version: 1, by: 'u1', set: { beds: 1 } })).rejects.toMatchObject({ status: 409 });
  });

  it('404 for a record that does not exist', async () => {
    await expect(updateRecord(db, 'wards', { id: newId(), version: 1, by: 'u1', set: { beds: 1 } })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('refuses odd names and base fields', async () => {
    const id = await addWard();
    await expect(updateRecord(db, 'wards; --', { id, version: 1, by: 'u', set: {} })).rejects.toThrow('Bad name');
    await expect(updateRecord(db, 'wards', { id, version: 1, by: 'u', set: { 'beds = 0, name': 1 } })).rejects.toThrow('Bad name');
    await expect(updateRecord(db, 'wards', { id, version: 1, by: 'u', set: { version: 9 } })).rejects.toThrow('Base fields');
  });
});

describe('history', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
    for (const sql of createTable('wards', ['name text NOT NULL', 'beds integer NOT NULL'])) await db.query(sql);
  });
  afterAll(() => db.close());

  const toWard = (r: Record<string, unknown>) => ({ ...baseFields(r as unknown as BaseRow), name: r.name, beds: r.beds });
  async function addWard(name: string) {
    const id = newId();
    await db.query("INSERT INTO wards (id, status, created_by, updated_by, name, beds) VALUES ($1, 'active', 'u0', 'u0', $2, 10)", [id, name]);
    return id;
  }

  it('keeps every old row, with who changed it and why', async () => {
    const id = await addWard('A');
    await updateRecord(db, 'wards', { id, version: 1, by: 'u1', set: { beds: 12 }, reason: 'new beds' });
    await updateRecord(db, 'wards', { id, version: 2, by: 'u2', set: { name: 'A1' } });

    const versions = await listVersions(db, 'wards', id, toWard);
    expect(versions.map(({ version, by, reason, data }) => ({ version, by, reason, name: data.name, beds: data.beds }))).toEqual([
      { version: 1, by: 'u0', reason: undefined, name: 'A', beds: 10 },
      { version: 2, by: 'u1', reason: 'new beds', name: 'A', beds: 12 },
      { version: 3, by: 'u2', reason: undefined, name: 'A1', beds: 12 },
    ]);
    // Old rows come back in the same shape as the live one (timestamps as dates).
    expect(versions[0]?.data.createdAt).toBe(versions[2]?.data.createdAt);
    expect(versions[0]?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('keeps nothing when the edit is refused', async () => {
    const id = await addWard('B');
    await expect(updateRecord(db, 'wards', { id, version: 7, by: 'u1', set: { beds: 6 } })).rejects.toMatchObject({ status: 409 });
    expect((await listVersions(db, 'wards', id, toWard)).map((v) => v.version)).toEqual([1]);
  });

  it('409 when another save already kept this version', async () => {
    const id = await addWard('C');
    await db.query("INSERT INTO wards_versions (record_id, version, data, replaced_by) VALUES ($1, 1, '{}', 'other')", [id]);
    await expect(updateRecord(db, 'wards', { id, version: 1, by: 'u1', set: { beds: 6 } })).rejects.toMatchObject({ status: 409 });
    expect((await db.query('SELECT version FROM wards WHERE id = $1', [id])).rows[0]).toEqual({ version: 1 });
  });

  it('a broken unique rule in the edit itself is not reported as a stale version', async () => {
    await db.query('CREATE UNIQUE INDEX wards_name ON wards (name)');
    await addWard('D');
    const id = await addWard('E');
    await expect(updateRecord(db, 'wards', { id, version: 1, by: 'u1', set: { name: 'D' } })).rejects.toMatchObject({ code: '23505' });
    expect((await listVersions(db, 'wards', id, toWard)).map((v) => v.version)).toEqual([1]);
  });

  it('404 for versions of a record that does not exist', async () => {
    await expect(listVersions(db, 'wards', newId(), toWard)).rejects.toMatchObject({ status: 404 });
  });
});

describe('withTransaction (BEGIN / COMMIT path used in AWS)', () => {
  function recorder(failOn?: string) {
    const log: string[] = [];
    const db: Queryable = {
      async query(sql) {
        log.push(sql);
        if (sql === failOn) throw new Error(`failed: ${sql}`);
        return { rows: [] };
      },
    };
    return { db, log };
  }

  it('commits when the work succeeds', async () => {
    const { db, log } = recorder();
    expect(await withTransaction(db, async (tx) => (await tx.query('INSERT x'), 'done'))).toBe('done');
    expect(log).toEqual(['BEGIN', 'INSERT x', 'COMMIT']);
  });

  it('rolls back and reports the first error', async () => {
    const { db, log } = recorder('INSERT x');
    await expect(withTransaction(db, (tx) => tx.query('INSERT x'))).rejects.toThrow('failed: INSERT x');
    expect(log).toEqual(['BEGIN', 'INSERT x', 'ROLLBACK']);
  });

  it('joins a transaction already open instead of starting another', async () => {
    const { db, log } = recorder();
    await withTransaction(db, (tx) => withTransaction(tx, (inner) => inner.query('INSERT x')));
    expect(log).toEqual(['BEGIN', 'INSERT x', 'COMMIT']);
    // Closed again afterwards: the next one starts its own.
    await withTransaction(db, (tx) => tx.query('INSERT y'));
    expect(log.slice(3)).toEqual(['BEGIN', 'INSERT y', 'COMMIT']);
  });

  it('undoes an inner step when the outer work fails (PGlite path)', async () => {
    const db = await openLocalDb();
    for (const sql of createTable('notes', ['text text NOT NULL'])) await db.query(sql);
    await expect(
      withTransaction(db, async (tx) => {
        await withTransaction(tx, (inner) =>
          inner.query("INSERT INTO notes (id, status, created_by, updated_by, text) VALUES ($1, 'active', 'u', 'u', 'x')", [newId()]),
        );
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect((await db.query('SELECT count(*)::int AS n FROM notes')).rows[0]).toEqual({ n: 0 });
    await db.close();
  });

  it('keeps nothing when the work fails (PGlite path)', async () => {
    const db = await openLocalDb();
    for (const sql of createTable('notes', ['text text NOT NULL'])) await db.query(sql);
    await expect(
      withTransaction(db, async (tx) => {
        await tx.query("INSERT INTO notes (id, status, created_by, updated_by, text) VALUES ($1, 'active', 'u', 'u', 'x')", [newId()]);
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect((await db.query('SELECT count(*)::int AS n FROM notes')).rows[0]).toEqual({ n: 0 });
    await db.close();
  });
});
