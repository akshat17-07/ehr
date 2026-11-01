import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import { seedId, seedInsert } from '../src/db/table.js';
import { BUILT_IN_BUNDLES, bundlesNamed, listBundles } from '../src/permissions/bundles.js';
import { PERMISSIONS } from '../src/permissions/catalog.js';
import { GRANT_ONLY } from '../src/permissions/defaults.js';

describe('bundles', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
  });
  afterAll(() => db.close());

  it('starts with the built-in bundles of section 4', async () => {
    const bundles = await listBundles(db);
    expect(bundles.map((b) => b.name)).toEqual(['billing', 'health_data', 'reception', 'records', 'store', 'tpa']);
    for (const b of bundles) {
      expect(b.builtIn).toBe(true);
      expect(b.version).toBe(1);
      expect(b.permissions).toEqual(BUILT_IN_BUNDLES[b.name as keyof typeof BUILT_IN_BUNDLES]);
    }
  });

  it('never bundles an Admin-only or grant-only permission', () => {
    const blocked = new Set([...PERMISSIONS.filter((p) => p.adminOnly).map((p) => p.key), ...GRANT_ONLY]);
    for (const [name, permissions] of Object.entries(BUILT_IN_BUNDLES)) {
      for (const p of permissions) expect(blocked.has(p), `${name}: ${p}`).toBe(false);
    }
  });

  it('finds bundles by name, leaving out unknown and voided ones', async () => {
    await db.query("INSERT INTO bundles (id, status, created_by, updated_by, name, permissions) VALUES (gen_random_uuid(), 'void', 'u', 'u', 'old_desk', '[]')");
    expect((await bundlesNamed(db, ['store', 'tpa', 'nope', 'old_desk'])).map((b) => b.name)).toEqual(['store', 'tpa']);
    expect(await bundlesNamed(db, [])).toEqual([]);
  });

  it('allows one bundle per name', async () => {
    await expect(
      db.query("INSERT INTO bundles (id, status, created_by, updated_by, name, permissions) VALUES (gen_random_uuid(), 'active', 'u', 'u', 'store', '[]')"),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('seed rows', () => {
  it('quote text safely and can run twice', async () => {
    const db = await openLocalDb();
    const sql = seedInsert('bundles', seedId('c0000000', 1), { name: "o'brien desk", permissions: '[]' });
    await db.query(sql);
    await db.query(sql);
    expect((await db.query("SELECT name FROM bundles WHERE name LIKE 'o%'")).rows).toEqual([{ name: "o'brien desk" }]);
    expect(() => seedInsert('bundles', seedId('c0000000', 2), { 'name) --': 'x' })).toThrow('Bad name');
    await db.close();
  });
});
