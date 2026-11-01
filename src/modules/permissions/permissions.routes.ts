import { Hono } from 'hono';
import type { AuthEnv } from '../../middleware/auth.js';
import { PERMISSIONS } from '../../permissions/catalog.js';
import { requirePermission } from '../../permissions/check.js';

// Custom permissions, for Admin and Head Doctor (api-list.md #305-#309, rules in section 4).

export const permissionsAdminRoutes = new Hono<AuthEnv>()
  // #305: the whole catalog, group by group, with en/hi text and whether only an Admin may give it.
  .get('/permissions', requirePermission('user.permissions'), (c) => c.json(PERMISSIONS));
