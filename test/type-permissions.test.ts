import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import { PERMISSIONS, type Permission } from '../src/permissions/catalog.js';
import { DEFAULT_TYPE_PERMISSIONS, GRANT_ONLY, STAFF_TYPES } from '../src/permissions/defaults.js';
import { listTypePermissions, permissionsOfTypes } from '../src/permissions/type-permissions.js';

const has = (type: keyof typeof DEFAULT_TYPE_PERMISSIONS, key: Permission) => DEFAULT_TYPE_PERMISSIONS[type].includes(key);

describe('built-in type permissions (api-list.md section 4)', () => {
  it('places every permission: built in for some type, or grant only', () => {
    const builtIn = new Set(Object.values(DEFAULT_TYPE_PERMISSIONS).flat());
    for (const { key } of PERMISSIONS) expect(builtIn.has(key) !== GRANT_ONLY.includes(key), key).toBe(true);
  });

  it('lists no permission twice for a type', () => {
    for (const type of STAFF_TYPES) expect(new Set(DEFAULT_TYPE_PERMISSIONS[type]).size, type).toBe(DEFAULT_TYPE_PERMISSIONS[type].length);
  });

  it('follows the table', () => {
    expect(has('nurse', 'vitals.record')).toBe(true);
    expect(has('nurse', 'rx.view')).toBe(true);
    expect(has('nurse', 'rx.write')).toBe(false);
    expect(has('medical', 'dispense.create')).toBe(true);
    expect(has('doctor', 'dispense.create')).toBe(false);
    expect(has('doctor', 'fhir.export')).toBe(true);
    expect(has('doctor', 'records.release')).toBe(false);
    expect(has('staff', 'patient.register')).toBe(false); // only with the reception bundle
    expect(has('admin', 'access.request')).toBe(false);
    expect(has('head_doctor', 'user.permissions')).toBe(true);
    expect(has('head_doctor', 'settings.manage')).toBe(false);
    expect(DEFAULT_TYPE_PERMISSIONS.insurance).toEqual([]);
    expect(DEFAULT_TYPE_PERMISSIONS.gp).toEqual([]);
  });

  it('gives Admin-only permissions to the Admin type only', () => {
    for (const { key } of PERMISSIONS.filter((p) => p.adminOnly)) {
      expect(STAFF_TYPES.filter((t) => has(t, key)), key).toEqual(['admin']);
    }
  });
});

describe('type_permissions table', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
  });
  afterAll(() => db.close());

  it('starts with the built-in list of every type, version 1', async () => {
    const all = await listTypePermissions(db);
    expect(all.map((t) => t.type)).toEqual([...STAFF_TYPES]);
    for (const t of all) {
      expect(t.version).toBe(1);
      expect(t.permissions).toEqual(DEFAULT_TYPE_PERMISSIONS[t.type]);
      expect(t.defaults).toEqual(DEFAULT_TYPE_PERMISSIONS[t.type]);
    }
  });

  it('combines the permissions of a set of types', async () => {
    const both = await permissionsOfTypes(db, ['nurse', 'medical']);
    expect(both.has('vitals.record') && both.has('dispense.create')).toBe(true);
    expect(both.has('rx.write')).toBe(false);
    expect((await permissionsOfTypes(db, [])).size).toBe(0);
    expect((await permissionsOfTypes(db, ['not_a_type'])).size).toBe(0);
  });

  it('allows one row per type', async () => {
    await expect(
      db.query("INSERT INTO type_permissions (id, status, created_by, updated_by, type, permissions) VALUES (gen_random_uuid(), 'active', 'u', 'u', 'nurse', '[]')"),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
