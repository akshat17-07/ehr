import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { applyDeposit } from './deposits.js';

const applyBody = z.object({ billId: z.uuid(), amountPaise: z.number().int().min(1).max(100_000_000) }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

// Mounted at /staff/deposits.
export const depositsRoutes = new Hono<AuthEnv>()
  // #128
  .post('/:id/apply', requirePermission('deposit.apply'), async (c) => {
    const input = applyBody.parse(await bodyOf(c));
    const result = await applyDeposit(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: result.deposit.patientId, recordType: 'deposit', recordId: result.deposit.id });
    return c.json(result);
  });
