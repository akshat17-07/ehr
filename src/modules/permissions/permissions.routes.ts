import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { PERMISSIONS } from '../../permissions/catalog.js';
import { loadPermissions, requirePermission } from '../../permissions/check.js';
import { addBundle, bundlesNamed, listBundles } from '../../permissions/bundles.js';
import { auditDetails } from '../../middleware/audit.js';
import { checkCustomLists, getCustomPermissions, saveBundles, saveCustomPermissions } from '../../permissions/custom.js';
import { STAFF_TYPES } from '../../permissions/defaults.js';
import { listTypePermissions, saveTypePermissions } from '../../permissions/type-permissions.js';
import { checkBundles, getUser } from '../users/users.js';
import { AppError } from '../../middleware/errors.js';
import { assertAdminRemains, assertMayChangeUser, assertMayGive, isAdmin } from './admin-rules.js';

// Custom permissions, for Admin and Head Doctor (api-list.md #305-#309, rules in section 4 and admin-rules.ts).

const reason = z.string().trim().min(5).max(500);

const customChange = z
  .object({
    version: z.number().int().min(0),
    allow: z.array(z.string()).max(200),
    deny: z.array(z.string()).max(200),
    reason,
  })
  .strict();

const bundlesChange = z
  .object({
    version: z.number().int().min(0),
    bundles: z.array(z.string().min(1).max(50)).max(20),
    reason,
  })
  .strict();

const typeChange = z
  .object({
    version: z.number().int().min(1),
    permissions: z.array(z.string()).max(300),
    reason,
  })
  .strict();

// Bundle names: lower case, as the built-in ones (front_desk, lab_staff ...).
const bundleName = z.string().trim().regex(/^[a-z][a-z0-9_]{1,49}$/, 'lower-case letters, digits and _');
const newBundle = z.object({ name: bundleName, permissions: z.array(z.string()).min(1).max(100) }).strict();

export const permissionsAdminRoutes = new Hono<AuthEnv>()
  // #164: every active bundle, by name.
  .get('/bundles', requirePermission('grant.view'), async (c) => c.json(await listBundles(await dbOf(c))))
  // #165 (Admin only)
  .post('/bundles', requirePermission('settings.bundles'), async (c) => {
    const body = newBundle.parse(await c.req.json().catch(() => undefined));
    const bundle = await addBundle(await dbOf(c), body, userOf(c).sub);
    auditDetails(c, { recordType: 'bundle', recordId: bundle.id });
    return c.json(bundle, 201);
  })

  // #305: the whole catalog, group by group, with en/hi text and whether only an Admin may give it.
  .get('/permissions', requirePermission('user.permissions'), (c) => c.json(PERMISSIONS))

  // #308: each staff type's permissions, with the built-in list for "reset".
  .get('/type-permissions', requirePermission('user.permissions'), async (c) => c.json(await listTypePermissions(await dbOf(c))))

  // #309: change a staff type's list; it applies to every user of that type.
  .put('/type-permissions/:type', requirePermission('user.permissions'), async (c) => {
    const db = await dbOf(c);
    const caller = userOf(c);
    const type = z.enum(STAFF_TYPES).parse(c.req.param('type'));
    const body = typeChange.parse(await c.req.json().catch(() => undefined));
    if (!isAdmin(caller) && (type === 'admin' || caller.groups.includes(type))) {
      throw new AppError(403, 'forbidden', 'a Head Doctor changes neither the Admin type nor their own type');
    }

    const { allow: permissions } = checkCustomLists(body.permissions, []);
    const before = (await listTypePermissions(db)).find((t) => t.type === type);
    assertMayGive(caller, permissions.filter((p) => !before?.permissions.includes(p)));
    if (type === 'admin') await assertAdminRemains(db, { adminType: permissions });

    return c.json(await saveTypePermissions(db, { type, version: body.version, permissions, by: caller.sub, reason: body.reason }));
  })

  // #306: a user's permissions and where each comes from.
  .get('/users/:id/permissions', requirePermission('user.permissions'), async (c) => {
    const db = await dbOf(c);
    const user = await getUser(db, c.req.param('id'));
    return c.json(await loadPermissions(db, user.cognitoSub, [user.type]));
  })

  // #307: set a user's custom allow and deny lists.
  .put('/users/:id/permissions', requirePermission('user.permissions'), async (c) => {
    const db = await dbOf(c);
    const caller = userOf(c);
    const body = customChange.parse(await c.req.json().catch(() => undefined));
    const user = await getUser(db, c.req.param('id'));
    assertMayChangeUser(caller, { sub: user.cognitoSub, type: user.type });

    const { allow, deny } = checkCustomLists(body.allow, body.deny);
    // Only a newly given permission is checked, so a Head Doctor can still edit a list an Admin made.
    const before = await getCustomPermissions(db, user.cognitoSub);
    assertMayGive(caller, allow.filter((p) => !before.allow.includes(p)));
    if (user.type === 'admin' && user.active) await assertAdminRemains(db, { custom: { sub: user.cognitoSub, allow, deny } });

    await saveCustomPermissions(db, { userId: user.cognitoSub, version: body.version, allow, deny, by: caller.sub, reason: body.reason });
    return c.json(await loadPermissions(db, user.cognitoSub, [user.type]));
  })

  // #157: set a user's bundles (the same limits as #307).
  .put('/users/:id/bundles', requirePermission('user.permissions'), async (c) => {
    const db = await dbOf(c);
    const caller = userOf(c);
    const body = bundlesChange.parse(await c.req.json().catch(() => undefined));
    const user = await getUser(db, c.req.param('id'));
    assertMayChangeUser(caller, { sub: user.cognitoSub, type: user.type });

    const names = [...new Set(body.bundles)];
    await checkBundles(db, names);
    const bundles = await bundlesNamed(db, names);
    const added = bundles.filter((b) => !user.bundles.includes(b.name));
    assertMayGive(caller, added.flatMap((b) => b.permissions));
    if (user.type === 'admin' && user.active) {
      const fromBundles = bundles.map((b) => ({ bundle: b.name, permissions: b.permissions }));
      await assertAdminRemains(db, { bundles: { sub: user.cognitoSub, fromBundles } });
    }

    await saveBundles(db, { userId: user.cognitoSub, version: body.version, bundles: names, by: caller.sub, reason: body.reason });
    return c.json(await getUser(db, user.id));
  });
