import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { endAgentLink } from './agent-links.js';

const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

// Mounted at /staff/agent-links.
export const agentLinksRoutes = new Hono<AuthEnv>()
  // #140
  .post('/:id/end', requirePermission('insurance.agent_link'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const link = await endAgentLink(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: link.patientId, recordType: 'agent_link', recordId: link.id, reason });
    return c.json(link);
  });
