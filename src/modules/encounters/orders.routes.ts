import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addResult, cancelOrder, listOrders, ORDER_KINDS, ORDER_STATUSES } from './orders.js';

// Orders across encounters (api-list.md #59-#61), mounted at /staff/orders. Orders are placed in an encounter (#58).

const listQuery = pageQuery.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  kind: z.enum(ORDER_KINDS).optional(),
  patientId: z.uuid().optional(),
  date: z.iso.date().optional(),
});

// documentId (a scanned report) is accepted once documents are built (#211); order_results.document_id exists.
const newResult = z
  .object({
    value: z.number().finite().optional(),
    unit: z.string().trim().min(1).max(30).optional(),
    text: z.string().trim().min(1).max(5000).optional(),
    resultedAt: z.iso.datetime({ offset: true }).optional(),
    documentId: z.uuid().optional(),
  })
  .strict()
  .refine((r) => r.value !== undefined || r.text !== undefined || r.documentId !== undefined, 'give a value, text or the report document')
  .refine((r) => r.unit === undefined || r.value !== undefined, { message: 'a unit goes with a value', path: ['unit'] });

const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const ordersRoutes = new Hono<AuthEnv>()
  // #59
  .get('/', requirePermission('order.view'), async (c) => c.json(await listOrders(await dbOf(c), listQuery.parse(c.req.query()))))
  // #60
  .post('/:id/results', requirePermission('result.record'), async (c) => {
    const input = newResult.parse(await bodyOf(c));
    const db = await dbOf(c);
    const result = await addResult(db, c.req.param('id'), input, userOf(c).sub);
    const order = (await db.query('SELECT patient_id FROM orders WHERE id = $1', [result.orderId])).rows[0];
    auditDetails(c, { patientId: String(order?.patient_id), recordType: 'order_result', recordId: result.id });
    return c.json(result, 201);
  })
  // #61
  .post('/:id/cancel', requirePermission('order.write'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const order = await cancelOrder(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: order.patientId, recordType: 'order', recordId: order.id, reason });
    return c.json(order);
  });
