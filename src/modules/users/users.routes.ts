import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { STAFF_TYPES } from '../../permissions/defaults.js';
import { requirePermission } from '../../permissions/check.js';
import { listUsers } from './users.js';

// /admin/users: staff accounts (api-list.md 7.2).

const boolText = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

const listQuery = pageQuery.extend({
  type: z.enum(STAFF_TYPES).optional(),
  departmentId: z.uuid().optional(),
  active: boolText,
  q: z.string().trim().min(2).max(100).optional(),
});

export const usersRoutes = new Hono<AuthEnv>().get('/', requirePermission('user.view'), async (c) => {
  const query = listQuery.parse(c.req.query());
  return c.json(await listUsers(await dbOf(c), query));
});
