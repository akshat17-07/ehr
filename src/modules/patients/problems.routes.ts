import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { resolveProblem } from './problems.js';

// Problems by id (api-list.md #57), mounted at /staff/problems. Problems are added on the patient (#56).

const resolveBody = z.object({ resolvedAt: z.iso.date().optional(), note: z.string().trim().min(1).max(500).optional() }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const problemsRoutes = new Hono<AuthEnv>()
  // #57
  .post('/:id/resolve', requirePermission('problem.write'), async (c) => {
    const input = resolveBody.parse(await bodyOf(c));
    const problem = await resolveProblem(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: problem.patientId, recordType: 'problem', recordId: problem.id, ...(input.note && { reason: input.note }) });
    return c.json(problem);
  });
