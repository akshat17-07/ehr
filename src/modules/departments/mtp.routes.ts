import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listMtp } from './mtp.js';

const listQuery = pageQuery.extend({ from: z.iso.date().optional(), to: z.iso.date().optional() });

/** /staff/mtp-register. A register spans departments, so only a grant for "all" opens it. */
export const mtpRoutes = new Hono<AuthEnv>()
  // #83
  .get('/', requirePermission('mtp.view'), async (c) => c.json(await listMtp(await dbOf(c), listQuery.parse(c.req.query()))));
