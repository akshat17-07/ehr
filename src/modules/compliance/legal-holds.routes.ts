import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { holdListQuery, listLegalHolds, newHoldBody, placeLegalHold, releaseHoldBody, releaseLegalHold } from './legal-holds.js';

// Mounted at /admin/legal-holds.
export const adminLegalHoldsRoutes = new Hono<AuthEnv>()
  // #337
  .get('/', requirePermission('compliance.legal_hold'), async (c) => {
    const query = holdListQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'legal_hold' });
    return c.json(await listLegalHolds(await dbOf(c), query));
  })
  // #338
  .post('/', requirePermission('compliance.legal_hold'), async (c) => {
    const input = newHoldBody.parse(await c.req.json().catch(() => undefined));
    const hold = await placeLegalHold(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'legal_hold', recordId: hold.id, patientId: hold.patientId });
    return c.json(hold, 201);
  })
  // #339
  .post('/:id/release', requirePermission('compliance.legal_hold'), async (c) => {
    const { reason } = releaseHoldBody.parse(await c.req.json().catch(() => undefined));
    const hold = await releaseLegalHold(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { recordType: 'legal_hold', recordId: hold.id, patientId: hold.patientId });
    return c.json(hold);
  });
