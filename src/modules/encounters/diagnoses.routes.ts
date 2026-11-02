import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { voidDiagnosis } from './diagnoses.js';

// Diagnoses by id (api-list.md #51), mounted at /staff/diagnoses. Diagnoses are added in an encounter (#50).

const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const diagnosesRoutes = new Hono<AuthEnv>()
  // #51
  .post('/:id/void', requirePermission('diagnosis.write'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const diagnosis = await voidDiagnosis(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: diagnosis.patientId, recordType: 'diagnosis', recordId: diagnosis.id, reason });
    return c.json(diagnosis);
  });
