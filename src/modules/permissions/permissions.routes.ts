import { Hono } from 'hono';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { PERMISSIONS } from '../../permissions/catalog.js';
import { loadPermissions, requirePermission } from '../../permissions/check.js';
import { getUser } from '../users/users.js';

// Custom permissions, for Admin and Head Doctor (api-list.md #305-#309).

export const permissionsAdminRoutes = new Hono<AuthEnv>()
  // #305: the whole catalog, group by group, with en/hi text and whether only an Admin may give it.
  .get('/permissions', requirePermission('user.permissions'), (c) => c.json(PERMISSIONS))

  // #306: a user's permissions and where each comes from.
  .get('/users/:id/permissions', requirePermission('user.permissions'), async (c) => {
    const db = await dbOf(c);
    const user = await getUser(db, c.req.param('id'));
    return c.json(await loadPermissions(db, user.cognitoSub, [user.type]));
  });
