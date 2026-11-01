import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { ACCESS_REQUEST_STATUSES, listMyAccessRequests } from './access-requests.js';

// /staff/me/access-requests: the access requests the caller made.

const listQuery = pageQuery.extend({ status: z.enum(ACCESS_REQUEST_STATUSES).optional() });

export const myAccessRequestsRoutes = new Hono<AuthEnv>().get('/', async (c) => {
  const query = listQuery.parse(c.req.query());
  return c.json(await listMyAccessRequests(await dbOf(c), userOf(c).sub, query));
});
