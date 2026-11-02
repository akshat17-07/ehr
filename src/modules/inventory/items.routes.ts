import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { ITEM_KINDS, listItems } from './items.js';

const itemsQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

/** /staff/inventory */
export const inventoryRoutes = new Hono<AuthEnv>()
  // #276
  .get('/items', requirePermission('stock.view'), async (c) => {
    const query = itemsQuery.parse(c.req.query());
    return c.json(await listItems(await dbOf(c), query));
  });
