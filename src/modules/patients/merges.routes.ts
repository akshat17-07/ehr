import { Hono } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { proposeMerge } from './merges.js';

// /staff/patient-merges (api-list.md 6.3). Approve and reject are under /admin (#181, #182).

const newMerge = z
  .object({ keepPatientId: z.uuid(), mergePatientId: z.uuid(), reason: z.string().trim().min(3).max(500) })
  .strict();

export const patientMergesRoutes = new Hono<AuthEnv>()
  // #28
  .post('/', requirePermission('patient.merge'), async (c) => {
    const input = newMerge.parse(await c.req.json().catch(() => undefined));
    const merge = await proposeMerge(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: merge.mergePatientId, recordType: 'patient_merge', recordId: merge.id, reason: merge.reason });
    return c.json(merge, 201);
  });
