import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { createPharmacyBill } from './bills.js';
import { pharmacyQueue, SETTINGS } from './queue.js';

const queueQuery = z.object({ date: z.iso.date().optional(), setting: z.enum(SETTINGS).optional() });

const newBill = z
  .object({
    patientId: z.uuid(),
    dispenseId: z.uuid().optional(),
    setting: z.enum(SETTINGS),
    lines: z
      .array(z.object({ drugId: z.uuid(), batchId: z.uuid(), qty: z.number().int().min(1).max(10_000) }).strict())
      .min(1)
      .max(30)
      .optional(),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/pharmacy */
export const pharmacyRoutes = new Hono<AuthEnv>()
  // #100
  .get('/queue', requirePermission('rx.view'), async (c) => {
    const query = queueQuery.parse(c.req.query());
    return c.json(await pharmacyQueue(await dbOf(c), query));
  })
  // #104
  .post('/bills', requirePermission('pharmacy_bill.create'), async (c) => {
    const input = newBill.parse(await bodyOf(c));
    const bill = await createPharmacyBill(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: bill.patientId, recordType: 'pharmacy_bill', recordId: bill.id });
    return c.json(bill, 201);
  });
