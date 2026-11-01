import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { PERMISSIONS } from '../../permissions/catalog.js';
import { loadPermissions, requirePermission } from '../../permissions/check.js';
import { checkCustomLists, getCustomPermissions, saveCustomPermissions } from '../../permissions/custom.js';
import { getUser } from '../users/users.js';
import { assertAdminRemains, assertMayChangeUser, assertMayGive } from './admin-rules.js';

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

export const permissionsAdminRoutes = new Hono<AuthEnv>()
  // #305: the whole catalog, group by group, with en/hi text and whether only an Admin may give it.
  .get('/permissions', requirePermission('user.permissions'), (c) => c.json(PERMISSIONS))

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
