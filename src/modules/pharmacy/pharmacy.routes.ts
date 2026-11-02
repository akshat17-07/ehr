import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { pharmacyQueue, SETTINGS } from './queue.js';

const queueQuery = z.object({ date: z.iso.date().optional(), setting: z.enum(SETTINGS).optional() });

/** /staff/pharmacy */
export const pharmacyRoutes = new Hono<AuthEnv>()
  // #100
  .get('/queue', requirePermission('rx.view'), async (c) => {
    const query = queueQuery.parse(c.req.query());
    return c.json(await pharmacyQueue(await dbOf(c), query));
  });
