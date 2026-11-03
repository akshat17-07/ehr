import { Hono } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { decideMerge, proposeMerge } from './merges.js';

// /staff/patient-merges (api-list.md 6.3). /admin/patient-merges: approve and reject (#181, #182).

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

const approveBody = z.object({ note: z.string().trim().min(1).max(500).optional() }).strict();
const rejectBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

export const adminPatientMergesRoutes = new Hono<AuthEnv>()
  // #181
  .post('/:id/approve', requirePermission('patient.merge'), async (c) => {
    const body = approveBody.parse(await c.req.json().catch(() => ({})));
    const merge = await decideMerge(await dbOf(c), c.req.param('id'), { approve: true, ...(body.note && { note: body.note }) }, userOf(c).sub);
    auditDetails(c, { action: 'update', patientId: merge.keepPatientId, recordType: 'patient_merge', recordId: merge.id, ...(body.note && { reason: body.note }) });
    return c.json(merge);
  })
  // #182
  .post('/:id/reject', requirePermission('patient.merge'), async (c) => {
    const body = rejectBody.parse(await c.req.json().catch(() => undefined));
    const merge = await decideMerge(await dbOf(c), c.req.param('id'), { approve: false, reason: body.reason }, userOf(c).sub);
    auditDetails(c, { action: 'update', patientId: merge.mergePatientId, recordType: 'patient_merge', recordId: merge.id, reason: body.reason });
    return c.json(merge);
  });
