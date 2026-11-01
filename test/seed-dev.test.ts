import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import { DEV_DRUGS, DEV_USERS, seedDev } from '../src/db/seed-dev.js';
import { loadPermissions } from '../src/permissions/check.js';
import { STAFF_TYPES } from '../src/permissions/defaults.js';

describe('dev seed', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
    await seedDev(db);
  });
  afterAll(() => db.close());

  const count = async (table: string) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n;

  it('adds one user of every staff type, departments and drugs', async () => {
    const { rows } = await db.query('SELECT DISTINCT type FROM users');
    expect(rows.map((r) => r.type).sort()).toEqual([...STAFF_TYPES].sort());
    expect(await count('departments')).toBe(9);
    expect(await count('drugs')).toBe(DEV_DRUGS.length);
  });

  it('can run again without adding anything', async () => {
    const before = [await count('users'), await count('departments'), await count('drugs'), await count('user_permissions')];
    await seedDev(db);
    expect([await count('users'), await count('departments'), await count('drugs'), await count('user_permissions')]).toEqual(before);
  });

  it('links users to real departments and gives the desk staff their bundles', async () => {
    const doctor = (await db.query("SELECT department_ids FROM users WHERE cognito_sub = 'dev-surgeon'")).rows[0];
    const ids = JSON.parse(String(doctor?.department_ids)) as string[];
    const { rows } = await db.query(`SELECT code FROM departments WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY code`, ids);
    expect(rows.map((r) => r.code)).toEqual(['ORT', 'SUR']);

    const reception = await loadPermissions(db, 'dev-reception', ['staff']);
    expect(reception.effective).toContain('patient.register');
    expect((await loadPermissions(db, 'dev-billing', ['staff'])).effective).toContain('bill.finalise');
  });

  it('uses only known drug schedules', () => {
    for (const [name, , , schedule] of DEV_DRUGS) expect(['OTC', 'H', 'H1', 'X', 'NDPS'], name).toContain(schedule);
    expect(new Set(DEV_USERS.map((u) => u.sub)).size).toBe(DEV_USERS.length);
  });
});
