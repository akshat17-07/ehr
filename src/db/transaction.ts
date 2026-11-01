import type { Queryable } from './migrate.js';

interface HasTransaction {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

// Transactions in progress. Work started inside one (e.g. updateRecord as one step of a check-in) joins it:
// a second BEGIN / COMMIT would end the outer transaction early, and the steps after it would no longer be undone.
const open = new WeakSet<Queryable>();

/**
 * Runs `fn` in one transaction: all of its writes are kept, or none. Inside another withTransaction it joins that one.
 * PGlite (dev, tests) has its own transaction() that also holds back other requests until it ends.
 * In AWS each Lambda container serves one request at a time on its own connection, so BEGIN / COMMIT is enough.
 */
export async function withTransaction<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  if (open.has(db)) return fn(db);
  const own = (db as Queryable & Partial<HasTransaction>).transaction;
  if (typeof own === 'function') {
    return own.call(db, (tx: Queryable) => {
      open.add(tx);
      return fn(tx);
    }) as Promise<T>;
  }
  await db.query('BEGIN');
  open.add(db);
  try {
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined); // the first error is the one worth reporting
    throw error;
  } finally {
    open.delete(db);
  }
}
