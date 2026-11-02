import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { voidAllergy } from './allergies.js';

// Allergies by id (api-list.md #54), mounted at /staff/allergies. Allergies are added on the patient (#53).

const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const allergiesRoutes = new Hono<AuthEnv>()
  // #54
  .post('/:id/void', requirePermission('allergy.write'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const allergy = await voidAllergy(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: allergy.patientId, recordType: 'allergy', recordId: allergy.id, reason });
    return c.json(allergy);
  });
