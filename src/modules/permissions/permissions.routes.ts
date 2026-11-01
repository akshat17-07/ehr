import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { PERMISSIONS } from '../../permissions/catalog.js';
import { loadPermissions, requirePermission } from '../../permissions/check.js';
import { checkCustomLists, getCustomPermissions, saveCustomPermissions } from '../../permissions/custom.js';
import { STAFF_TYPES } from '../../permissions/defaults.js';
import { listTypePermissions, saveTypePermissions } from '../../permissions/type-permissions.js';
import { getUser } from '../users/users.js';
import { assertAdminRemains, assertMayChangeUser, assertMayGive, isAdmin } from './admin-rules.js';
import { AppError } from '../../middleware/errors.js';

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

const typeChange = z
  .object({
    version: z.number().int().min(1),
    permissions: z.array(z.string()).max(300),
    reason,
  })
  .strict();

export const permissionsAdminRoutes = new Hono<AuthEnv>()
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
  });
