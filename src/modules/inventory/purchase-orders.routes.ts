import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { OPEN_PO_STATUSES, openPurchaseOrders } from './purchase-orders.js';

const openQuery = z.object({ status: z.enum(OPEN_PO_STATUSES).optional(), supplierId: z.uuid().optional() });

/** /staff/purchase-orders */
export const purchaseOrdersRoutes = new Hono<AuthEnv>()
  // #283
  .get('/', requirePermission('stock.view'), async (c) => {
    const query = openQuery.parse(c.req.query());
    return c.json(await openPurchaseOrders(await dbOf(c), query));
  });
