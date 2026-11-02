import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listSurgeries, SURGERY_STATUSES } from './surgeries.js';

const listQuery = z
  .object({ from: z.iso.date(), to: z.iso.date(), surgeonId: z.uuid().optional(), status: z.enum(SURGERY_STATUSES).optional() })
  .strict();

/** /staff/surgeries */
export const surgeriesRoutes = new Hono<AuthEnv>()
  // #86
  .get('/', requirePermission('surgery.view'), async (c) => c.json(await listSurgeries(await dbOf(c), listQuery.parse(c.req.query()))));
