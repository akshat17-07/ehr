import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { ITEM_KINDS } from './items.js';
import { listStock } from './stock.js';

const stockQuery = pageQuery.extend({
  itemId: z.uuid().optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

/** /staff/stock */
export const stockRoutes = new Hono<AuthEnv>()
  // #107
  .get('/', requirePermission('stock.view'), async (c) => {
    const query = stockQuery.parse(c.req.query());
    return c.json(await listStock(await dbOf(c), query));
  });
