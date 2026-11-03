import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { ACCESS_REQUEST_STATUSES, createAccessRequest, listAccessRequests, listMyAccessRequests } from './access-requests.js';

// /staff/me/access-requests: the access requests the caller made. /staff/access-requests: asking for one.
// /admin/access-requests: deciding them.

const listQuery = pageQuery.extend({ status: z.enum(ACCESS_REQUEST_STATUSES).optional() });

export const myAccessRequestsRoutes = new Hono<AuthEnv>().get('/', async (c) => {
  const query = listQuery.parse(c.req.query());
  return c.json(await listMyAccessRequests(await dbOf(c), userOf(c).sub, query));
});

const newRequest = z.object({ patientId: z.uuid(), reason: z.string().trim().min(3).max(500) }).strict();

export const accessRequestsRoutes = new Hono<AuthEnv>()
  // #29
  .post('/', requirePermission('access.request'), async (c) => {
    const input = newRequest.parse(await c.req.json().catch(() => undefined));
    const request = await createAccessRequest(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: request.patientId, recordType: 'access_request', recordId: request.id, reason: request.reason });
    return c.json(request, 201);
  });

export const adminAccessRequestsRoutes = new Hono<AuthEnv>()
  // #174
  .get('/', requirePermission('approval.access'), async (c) => c.json(await listAccessRequests(await dbOf(c), listQuery.parse(c.req.query()))));
