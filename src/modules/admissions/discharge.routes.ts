import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { rxLine } from '../prescriptions/prescriptions.routes.js';
import { updateSummary } from './discharge.js';

// Discharge summaries by id (api-list.md #75-#76), mounted at /staff/discharge-summaries. Written on the encounter (#74).

const longText = z.string().trim().min(1).max(10_000);

export const summaryFields = {
  diagnosisText: z.string().trim().min(2).max(1000),
  course: longText,
  procedures: longText.optional(),
  medicinesOnDischarge: z.array(rxLine).max(30),
  advice: longText,
  followUpDate: z.iso.date().optional(),
};

const summaryChange = z
  .object({ version: z.number().int().min(1), ...summaryFields })
  .partial({ diagnosisText: true, course: true, medicinesOnDischarge: true, advice: true })
  .strict()
  .refine((b) => Object.keys(b).length > 1, 'change at least one field');

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const dischargeRoutes = new Hono<AuthEnv>()
  // #75
  .patch('/:id', requirePermission('discharge.write'), async (c) => {
    const input = summaryChange.parse(await bodyOf(c));
    const summary = await updateSummary(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: summary.patientId, recordType: 'discharge_summary', recordId: summary.id });
    return c.json(summary);
  });
