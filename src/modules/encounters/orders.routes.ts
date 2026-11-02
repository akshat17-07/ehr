import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { listOrders, ORDER_KINDS, ORDER_STATUSES } from './orders.js';

// Orders across encounters (api-list.md #59-#61), mounted at /staff/orders. Orders are placed in an encounter (#58).

const listQuery = pageQuery.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  kind: z.enum(ORDER_KINDS).optional(),
  patientId: z.uuid().optional(),
  date: z.iso.date().optional(),
});

export const ordersRoutes = new Hono<AuthEnv>()
  // #59
  .get('/', requirePermission('order.view'), async (c) => c.json(await listOrders(await dbOf(c), listQuery.parse(c.req.query()))));
