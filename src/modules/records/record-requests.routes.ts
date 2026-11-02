import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listRecordRequests, RECORD_REQUEST_STATUSES } from './record-requests.js';

const listQuery = pageQuery.extend({ status: z.enum(RECORD_REQUEST_STATUSES).optional(), overdue: z.enum(['true', 'false']).optional() }).strict();

// Mounted at /staff/record-requests.
export const recordRequestsRoutes = new Hono<AuthEnv>()
  // #145
  .get('/', requirePermission('records.release'), async (c) => c.json(await listRecordRequests(await dbOf(c), listQuery.parse(c.req.query()))));
