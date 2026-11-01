import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { listAlerts, markAlertRead } from './alerts.js';

// /staff/me/alerts: the caller's own alerts only.

const listQuery = pageQuery.extend({
  unread: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const myAlertsRoutes = new Hono<AuthEnv>().get('/', async (c) => {
  const query = listQuery.parse(c.req.query());
  return c.json(await listAlerts(await dbOf(c), userOf(c).sub, query));
}).post('/:id/read', async (c) => c.json(await markAlertRead(await dbOf(c), userOf(c).sub, c.req.param('id'))));
