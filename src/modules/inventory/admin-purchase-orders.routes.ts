import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { changePurchaseOrder, createPurchaseOrder, listPurchaseOrders, purchaseOrderDetail, PO_STATUSES } from './purchase-orders.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const listQuery = pageQuery.extend({
  status: z.enum(PO_STATUSES).optional(),
  supplierId: z.uuid().optional(),
  from: day.optional(),
  to: day.optional(),
});
const line = z
  .object({ itemId: z.uuid(), qty: z.number().int().min(1).max(1_000_000), ratePaise: z.number().int().min(0).max(100_000_000).optional() })
  .strict();
const note = z.string().trim().min(1).max(1000);
const newOrder = z
  .object({ supplierId: z.uuid(), reorderCheckId: z.uuid().optional(), lines: z.array(line).max(500).optional(), note: note.optional() })
  .strict();
const orderChange = z
  .object({ version: z.number().int().min(1), lines: z.array(line).max(500).optional(), note: note.nullable().optional() })
  .strict();

/** /admin/purchase-orders (#295-#298; place, cancel and print follow at #299-#301) */
export const adminPurchaseOrdersRoutes = new Hono<AuthEnv>()
  // #295
  .post('/', requirePermission('purchase.create'), async (c) => {
    const input = newOrder.parse(await c.req.json().catch(() => undefined));
    const order = await createPurchaseOrder(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'purchase_order', recordId: order.id });
    return c.json(order, 201);
  })
  // #296
  .get('/', requirePermission('purchase.create'), async (c) => c.json(await listPurchaseOrders(await dbOf(c), listQuery.parse(c.req.query()))))
  // #297
  .get('/:id', requirePermission('purchase.create'), async (c) => c.json(await purchaseOrderDetail(await dbOf(c), c.req.param('id'))))
  // #298
  .patch('/:id', requirePermission('purchase.create'), async (c) => {
    const input = orderChange.parse(await c.req.json().catch(() => undefined));
    const order = await changePurchaseOrder(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { recordType: 'purchase_order', recordId: order.id });
    return c.json(order);
  });
