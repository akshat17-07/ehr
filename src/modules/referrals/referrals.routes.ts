import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { searchReferrers } from './referrers.js';

const searchQuery = z.object({ q: z.string().trim().min(2).max(100), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();

// Mounted at /staff/referrers.
export const referrersRoutes = new Hono<AuthEnv>()
  // #141
  .get('/', requirePermission('referrer.view'), async (c) => c.json(await searchReferrers(await dbOf(c), searchQuery.parse(c.req.query()))));
