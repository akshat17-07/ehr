import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listRightsRequests, rightsListQuery } from './rights-requests.js';

// Mounted at /admin/rights-requests.
export const adminRightsRequestsRoutes = new Hono<AuthEnv>()
  // #332
  .get('/', requirePermission('compliance.rights'), async (c) => {
    const query = rightsListQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'rights_request' });
    return c.json(await listRightsRequests(await dbOf(c), query));
  });
