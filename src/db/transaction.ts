import type { Queryable } from './migrate.js';

interface HasTransaction {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Runs `fn` in one transaction: all of its writes are kept, or none.
 * PGlite (dev, tests) has its own transaction() that also holds back other requests until it ends.
 * In AWS each Lambda container serves one request at a time on its own connection, so BEGIN / COMMIT is enough.
 */
export async function withTransaction<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const own = (db as Queryable & Partial<HasTransaction>).transaction;
  if (typeof own === 'function') return own.call(db, fn) as Promise<T>;
  await db.query('BEGIN');
  try {
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined); // the first error is the one worth reporting
    throw error;
  }
}
