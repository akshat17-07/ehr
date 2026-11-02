import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { admit } from './admissions.js';

// Admissions (api-list.md #69-#73), mounted at /staff/admissions.

export const ward = z.string().trim().min(1).max(50);
export const bed = z.string().trim().min(1).max(20);

const newAdmission = z
  .object({
    patientId: z.uuid(),
    departmentId: z.uuid(),
    doctorId: z.uuid(),
    ward,
    bed,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const admissionsRoutes = new Hono<AuthEnv>()
  // #69
  .post('/', requirePermission('admission.create'), async (c) => {
    const admission = await admit(await dbOf(c), newAdmission.parse(await bodyOf(c)), userOf(c).sub);
    auditDetails(c, { patientId: admission.patientId, recordType: 'admission', recordId: admission.id });
    return c.json(admission, 201);
  });
