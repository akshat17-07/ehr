import { Hono } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { changeLabels } from './labels.js';
import { SENSITIVE_LABELS } from './patients.js';

// /admin/patients: management of a patient's sensitive labels (#187) and the access log (#188).

const labelsBody = z
  .object({ add: z.array(z.enum(SENSITIVE_LABELS)).max(4).optional(), remove: z.array(z.enum(SENSITIVE_LABELS)).max(4).optional(), reason: z.string().trim().min(5).max(500) })
  .strict()
  .refine((b) => (b.add?.length ?? 0) + (b.remove?.length ?? 0) > 0, { message: 'add or remove at least one label', path: ['add'] });

export const adminPatientsRoutes = new Hono<AuthEnv>()
  // #187
  .post('/:id/labels', requirePermission('sensitive.label'), async (c) => {
    const body = labelsBody.parse(await c.req.json().catch(() => undefined));
    const { patient, before } = await changeLabels(await dbOf(c), c.req.param('id'), body, userOf(c).sub);
    auditDetails(c, {
      action: 'update',
      patientId: patient.id,
      recordType: 'patient',
      recordId: patient.id,
      changes: { labels: [before, patient.labels] },
      reason: body.reason,
    });
    return c.json(patient);
  });
