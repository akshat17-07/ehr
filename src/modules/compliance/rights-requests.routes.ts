import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listRightsRequests, respondToRightsRequest, rightsListQuery, rightsRespondBody } from './rights-requests.js';

// Mounted at /admin/rights-requests.
export const adminRightsRequestsRoutes = new Hono<AuthEnv>()
  // #332
  .get('/', requirePermission('compliance.rights'), async (c) => {
    const query = rightsListQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'rights_request' });
    return c.json(await listRightsRequests(await dbOf(c), query));
  })
  // #333
  .post('/:id/respond', requirePermission('compliance.rights'), async (c) => {
    const input = rightsRespondBody.parse(await c.req.json().catch(() => undefined));
    const done = await respondToRightsRequest(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { recordType: 'rights_request', recordId: done.id, patientId: done.patientId });
    return c.json(done);
  });
