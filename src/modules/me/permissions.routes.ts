import { Hono } from 'hono';
import type { AuthEnv } from '../../middleware/auth.js';
import { permissionList, permissionsOf } from '../../permissions/check.js';

// GET /staff/me/permissions (#2): what the caller may do, so the screen can hide the rest.
export const myPermissionsRoutes = new Hono<AuthEnv>().get('/', async (c) =>
  c.json({ permissions: permissionList(await permissionsOf(c)) }),
);
