import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { pageQuery } from '../../db/page.js';
import { CLAIM_KINDS, CLAIM_STATUSES, createClaim, getClaim, listClaims } from './claims.js';

const newClaim = z
  .object({
    patientId: z.uuid(),
    policyId: z.uuid(),
    admissionId: z.uuid().optional(),
    kind: z.enum(CLAIM_KINDS),
    amountClaimedPaise: z.number().int().min(1).max(100_000_000_000),
    documentIds: z.array(z.uuid()).max(50).optional(),
  })
  .strict();

const claimsQuery = pageQuery.extend({
  status: z.enum(CLAIM_STATUSES).optional(),
  patientId: z.uuid().optional(),
  insurerId: z.uuid().optional(),
  overdue: z.enum(['true', 'false']).optional(),
});

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

// Mounted at /staff/claims.
export const claimsRoutes = new Hono<AuthEnv>()
  // #134
  .post('/', requirePermission('claim.create'), async (c) => {
    const input = newClaim.parse(await bodyOf(c));
    const claim = await createClaim(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: claim.patientId, recordType: 'claim', recordId: claim.id });
    return c.json(claim, 201);
  })
  // #135
  .get('/', requirePermission('claim.view'), async (c) => c.json(await listClaims(await dbOf(c), claimsQuery.parse(c.req.query()))))
  // #136
  .get('/:id', requirePermission('claim.view'), async (c) => {
    const claim = await getClaim(await dbOf(c), c.req.param('id'));
    auditDetails(c, { patientId: claim.patientId, recordType: 'claim', recordId: claim.id });
    return c.json(claim);
  });
