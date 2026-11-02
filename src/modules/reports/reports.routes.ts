import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { dayClose } from './day-close.js';

const dayCloseQuery = z.object({ date: z.iso.date(), userId: z.string().trim().min(1).max(200).optional() }).strict();

// Mounted at /staff/reports.
export const reportsRoutes = new Hono<AuthEnv>()
  // #130
  .get('/day-close', requirePermission('report.finance'), async (c) => c.json(await dayClose(await dbOf(c), dayCloseQuery.parse(c.req.query()))));
