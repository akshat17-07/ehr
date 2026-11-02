import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { dispense } from './dispenses.js';

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

const newDispense = z
  .object({
    prescriptionId: z.uuid(),
    lines: z
      .array(
        z
          .object({
            lineIndex: z.number().int().min(0).max(29),
            drugId: z.uuid(),
            batchId: z.uuid(),
            qty: z.number().int().min(1).max(10_000),
            h1: z.object({ prescriberName: text(2, 100), prescriberRegNo: text(2, 50) }).strict().optional(),
            ndps: z.object({ patientIdProof: text(4, 100), address: text(5, 300) }).strict().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/dispenses */
export const dispensesRoutes = new Hono<AuthEnv>()
  // #101
  .post('/', requirePermission('dispense.create'), async (c) => {
    const input = newDispense.parse(await bodyOf(c));
    const given = await dispense(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: given.patientId, recordType: 'dispense', recordId: given.id });
    return c.json(given, 201);
  });
