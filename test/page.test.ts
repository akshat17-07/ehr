import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, pageQuery, pageRows, type PageQuery, type PageSpec } from '../src/db/page.js';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import { createTable } from '../src/db/table.js';

const ids = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
// Rows 2-4 share one time, so only the id keeps their order.
const times = ['2026-01-01', '2026-01-02', '2026-01-02', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'];

const spec: PageSpec = { select: 'SELECT id, created_at, ward FROM beds', orderBy: ['created_at', 'id'] };
const toId = (r: Record<string, unknown>) => String(r.id);

async function all(db: LocalDb, s: PageSpec, limit: number) {
  const seen: string[] = [];
  let query: PageQuery = { limit };
  for (let pages = 0; pages < 20; pages++) {
    const page = await pageRows(db, s, query, toId);
    seen.push(...page.items);
    if (!page.nextCursor) return seen;
    query = { limit, cursor: page.nextCursor };
  }
  throw new Error('never ended');
}

describe('paging', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
    for (const sql of createTable('beds', ['ward text NOT NULL'])) await db.query(sql);
    for (const [i, id] of ids.entries()) {
      await db.query(
        "INSERT INTO beds (id, status, created_by, updated_by, created_at, ward) VALUES ($1, 'active', 'u', 'u', $2, $3)",
        [id, times[i], i % 2 ? 'B' : 'A'],
      );
    }
  });
  afterAll(() => db.close());

  it('walks every row once, newest first, ties broken by id', async () => {
    expect(await all(db, spec, 3)).toEqual([...ids].reverse());
  });

  it('walks oldest first when asked', async () => {
    expect(await all(db, { ...spec, direction: 'asc' }, 2)).toEqual(ids);
  });

  it('keeps filters on every page', async () => {
    const wardA = { ...spec, where: ['ward = $1'], params: ['A'] };
    expect(await all(db, wardA, 2)).toEqual([ids[6], ids[4], ids[2], ids[0]]);
  });

  it('has no nextCursor on the last page', async () => {
    expect(await pageRows(db, spec, { limit: 7 }, toId)).toEqual({ items: [...ids].reverse() });
    expect((await pageRows(db, spec, { limit: 6 }, toId)).nextCursor).toBeDefined();
  });

  it('rejects a cursor that was changed or made up', async () => {
    for (const cursor of ['nonsense', encodeCursor(['only-one']), Buffer.from('{"a":1}').toString('base64url')]) {
      await expect(pageRows(db, spec, { limit: 2, cursor }, toId)).rejects.toMatchObject({ status: 422 });
    }
  });

  it('round-trips a cursor', () => {
    expect(decodeCursor(encodeCursor(['2026-01-02T00:00:00.000Z', ids[0] as string]), 2)).toEqual([
      '2026-01-02T00:00:00.000Z',
      ids[0],
    ]);
  });

  it('refuses sort columns that are not plain names', async () => {
    await expect(pageRows(db, { ...spec, orderBy: ['id; DROP TABLE beds'] }, { limit: 1 }, toId)).rejects.toThrow('Bad orderBy');
  });

  it('reads limit and cursor from the query string', () => {
    expect(pageQuery.parse({})).toEqual({ limit: 50 });
    expect(pageQuery.parse({ limit: '7', cursor: 'abc' })).toEqual({ limit: 7, cursor: 'abc' });
    for (const limit of ['0', '101', '2.5', 'ten']) expect(pageQuery.safeParse({ limit }).success).toBe(false);
  });
});
