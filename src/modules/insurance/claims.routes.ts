import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { pageQuery } from '../../db/page.js';
import { addClaimDocuments, addClaimEvent, CLAIM_KINDS, CLAIM_STATUSES, createClaim, getClaim, listClaims } from './claims.js';

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

const newEvent = z
  .object({
    status: z.enum(['submitted', 'query', 'approved', 'rejected', 'settled']),
    note: z.string().trim().min(1).max(2000).optional(),
    amountPaise: z.number().int().min(0).max(100_000_000_000).optional(),
  })
  .strict()
  .refine((e) => (e.status !== 'approved' && e.status !== 'settled') || e.amountPaise !== undefined, {
    message: 'needed for approved and settled',
    path: ['amountPaise'],
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
  })
  // #137
  .post('/:id/events', requirePermission('claim.update'), async (c) => {
    const input = newEvent.parse(await bodyOf(c));
    const db = await dbOf(c);
    const event = await addClaimEvent(db, c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: (await getClaim(db, event.claimId)).patientId, recordType: 'claim', recordId: event.claimId });
    return c.json(event, 201);
  })
  // #138
  .post('/:id/documents', requirePermission('claim.update'), async (c) => {
    const input = z.object({ documentIds: z.array(z.uuid()).min(1).max(50) }).strict().parse(await bodyOf(c));
    const claim = await addClaimDocuments(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: claim.patientId, recordType: 'claim', recordId: claim.id });
    return c.json(claim);
  });
