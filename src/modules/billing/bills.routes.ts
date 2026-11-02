import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { createBill } from './bills.js';

export const lineInput = z
  .object({
    tariffId: z.uuid().optional(),
    text: z.string().trim().min(1).max(200).optional(),
    qty: z.number().int().min(1).max(10_000),
    unitPaise: z.number().int().min(0).max(100_000_000).optional(),
  })
  .strict();

const newBill = z
  .object({ patientId: z.uuid(), encounterId: z.uuid().optional(), admissionId: z.uuid().optional(), lines: z.array(lineInput).max(200) })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/bills */
export const billsRoutes = new Hono<AuthEnv>()
  // #116
  .post('/', requirePermission('bill.create'), async (c) => {
    const input = newBill.parse(await bodyOf(c));
    const bill = await createBill(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: bill.patientId, recordType: 'bill', recordId: bill.id });
    return c.json(bill, 201);
  });
