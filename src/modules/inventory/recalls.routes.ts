import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { recallBatches } from './recalls.js';

const newRecall = z
  .object({
    itemId: z.uuid(),
    batchNos: z.array(z.string().trim().min(1).max(50)).min(1).max(100),
    reference: z.string().trim().min(3).max(200),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/recalls */
export const recallsRoutes = new Hono<AuthEnv>()
  // #112
  .post('/', requirePermission('stock.quarantine'), async (c) => {
    const input = newRecall.parse(await bodyOf(c));
    const recall = await recallBatches(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'recall', recordId: recall.id });
    return c.json(recall, 201);
  });
