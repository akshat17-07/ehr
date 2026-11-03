import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { updatePolicy } from './policies.js';

/** The Policy fields a caller sends (#132, #133). */
export const policyFields = {
  insurerId: z.uuid(),
  tpaId: z.uuid().optional(),
  policyNo: z.string().trim().min(1).max(60),
  memberId: z.string().trim().min(1).max(60).optional(),
  holderName: z.string().trim().min(1).max(200),
  validFrom: z.iso.date(),
  validTo: z.iso.date(),
  sumInsuredPaise: z.number().int().min(0).max(100_000_000_000).optional(),
  documentIds: z.array(z.uuid()).max(20).optional(),
};

/** The #133 body (also #263). */
export const policyChange = z
  .object({
    ...policyFields,
    tpaId: policyFields.tpaId.unwrap().nullable(),
    memberId: policyFields.memberId.unwrap().nullable(),
    sumInsuredPaise: policyFields.sumInsuredPaise.unwrap().nullable(),
  })
  .partial()
  .extend({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(500).optional() })
  .strict()
  .refine((c) => Object.keys(c).some((k) => k !== 'version' && k !== 'reason'), { message: 'nothing to change', path: ['version'] });

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

// Mounted at /staff/policies.
export const policiesRoutes = new Hono<AuthEnv>()
  // #133
  .patch('/:id', requirePermission('insurance.policy'), async (c) => {
    const change = policyChange.parse(await bodyOf(c));
    const policy = await updatePolicy(await dbOf(c), c.req.param('id'), change, userOf(c).sub);
    auditDetails(c, { patientId: policy.patientId, recordType: 'policy', recordId: policy.id, ...(change.reason && { reason: change.reason }) });
    return c.json(policy);
  });
