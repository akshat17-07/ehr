import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { ACCESS_REQUEST_STATUSES, createAccessRequest, decideAccessRequest, DEFAULT_ACCESS_HOURS, listAccessRequests, listMyAccessRequests } from './access-requests.js';

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

const approveBody = z.object({ hours: z.number().int().min(1).max(720).optional(), note: z.string().trim().min(1).max(500).optional() }).strict();
const rejectBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

export const adminAccessRequestsRoutes = new Hono<AuthEnv>()
  // #174
  .get('/', requirePermission('approval.access'), async (c) => c.json(await listAccessRequests(await dbOf(c), listQuery.parse(c.req.query()))))
  // #175
  .post('/:id/approve', requirePermission('approval.access'), async (c) => {
    const body = approveBody.parse(await c.req.json().catch(() => ({})));
    const request = await decideAccessRequest(
      await dbOf(c),
      c.req.param('id'),
      { approve: true, hours: body.hours ?? DEFAULT_ACCESS_HOURS, ...(body.note && { note: body.note }) },
      userOf(c).sub,
    );
    auditDetails(c, { action: 'grant', patientId: request.patientId, recordType: 'access_request', recordId: request.id, ...(body.note && { reason: body.note }) });
    return c.json(request);
  })
  // #176
  .post('/:id/reject', requirePermission('approval.access'), async (c) => {
    const body = rejectBody.parse(await c.req.json().catch(() => undefined));
    const request = await decideAccessRequest(await dbOf(c), c.req.param('id'), { approve: false, reason: body.reason }, userOf(c).sub);
    auditDetails(c, { action: 'update', patientId: request.patientId, recordType: 'access_request', recordId: request.id, reason: body.reason });
    return c.json(request);
  });
