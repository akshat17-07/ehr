import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../src/db/local.js';
import { listVersions } from '../src/db/records.js';
import { checkCustomLists, getCustomPermissions, saveCustomPermissions } from '../src/permissions/custom.js';

describe('custom permissions', () => {
  let db: LocalDb;
  beforeAll(async () => {
    db = await openLocalDb();
  });
  afterAll(() => db.close());

  it('a user starts with none, version 0', async () => {
    expect(await getCustomPermissions(db, 'nobody')).toEqual({ version: 0, allow: [], deny: [] });
  });

  it('saves the first change, then edits with the version check, keeping the old row', async () => {
    const first = { userId: 'u-nurse', allow: ['bill.view'], deny: ['breakglass.invoke'], by: 'u-admin', reason: 'billing desk' };
    expect(await saveCustomPermissions(db, { ...first, version: 0 })).toEqual({ version: 1, allow: ['bill.view'], deny: ['breakglass.invoke'] });
    await expect(saveCustomPermissions(db, { ...first, version: 0 })).rejects.toMatchObject({ status: 409 });

    const second = { ...first, version: 1, allow: ['bill.view', 'bill.create', 'bill.view'], reason: 'more billing' };
    expect(await saveCustomPermissions(db, second)).toEqual({ version: 2, allow: ['bill.create', 'bill.view'], deny: ['breakglass.invoke'] });
    await expect(saveCustomPermissions(db, second)).rejects.toMatchObject({ status: 409 });

    expect(await getCustomPermissions(db, 'u-nurse')).toMatchObject({ version: 2, allow: ['bill.create', 'bill.view'] });
    const id = String((await db.query("SELECT id FROM user_permissions WHERE user_id = 'u-nurse'")).rows[0]?.id);
    const versions = await listVersions(db, 'user_permissions', id, (r) => r.allow);
    expect(versions.map((v) => [v.version, v.reason, v.data])).toEqual([
      [1, undefined, '["bill.view"]'],
      [2, 'more billing', '["bill.create","bill.view"]'],
    ]);
  });

  it('409 when the editor read version 3 of a user with no row', async () => {
    await expect(
      saveCustomPermissions(db, { userId: 'u-new', version: 3, allow: [], deny: [], by: 'u-admin', reason: 'x' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses unknown keys, keys in both lists, and grant-only permissions', () => {
    expect(() => checkCustomLists(['patient.delete'], [])).toThrow('unknown permission: patient.delete');
    expect(() => checkCustomLists([], ['stock.remove'])).toThrow('unknown permission: stock.remove');
    expect(() => checkCustomLists(['bill.view'], ['bill.view'])).toThrow('in both allow and deny');
    expect(() => checkCustomLists(['pcpndt.write'], [])).toThrow('given only with a grant');
    expect(() => checkCustomLists([], ['pcpndt.write'])).not.toThrow(); // denying is always allowed
  });
});
