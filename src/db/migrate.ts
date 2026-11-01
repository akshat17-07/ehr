import { migrations as allMigrations, toPostgres, type Migration, type MigrationContext } from './migrations.js';

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// Postgres error codes that mean "this already exists", so a migration that half-ran can safely run again.
const ALREADY_EXISTS = new Set(['42710', '42P07', '42P06', '42701']);

function alreadyExists(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return (e.code !== undefined && ALREADY_EXISTS.has(e.code)) || /already (exists|granted)/i.test(e.message ?? '');
}

/** Runs every migration not yet in schema_migrations, in order. Returns the ids it applied. */
export async function migrate(
  db: Queryable,
  ctx: MigrationContext,
  migrations: Migration[] = allMigrations,
): Promise<string[]> {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const { rows } = await db.query('SELECT id FROM schema_migrations');
  const done = new Set(rows.map((r) => String(r.id)));

  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    for (const statement of migration.statements(ctx)) {
      const sql = ctx.dialect === 'postgres' ? toPostgres(statement) : statement;
      if (sql === null) continue;
      try {
        await db.query(sql);
      } catch (error) {
        if (!alreadyExists(error)) throw error;
      }
    }
    await db.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
    applied.push(migration.id);
  }
  return applied;
}
