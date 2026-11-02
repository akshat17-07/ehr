import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { drugRegister } from './registers.js';

const period = z.object({ from: z.iso.date(), to: z.iso.date() });

/** /staff/registers */
export const registersRoutes = new Hono<AuthEnv>()
  // #113
  .get('/h1', requirePermission('register.print'), async (c) => {
    const query = period.parse(c.req.query());
    return c.json(await drugRegister(await dbOf(c), 'h1', query));
  });
