import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addItem, ITEM_KINDS, listItems } from './items.js';

const itemsQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const newItem = z
  .object({
    name: z.string().trim().min(2).max(200),
    // Drugs are added at #193.
    kind: z.enum(ITEM_KINDS).exclude(['drug']),
    unit: z.string().trim().min(1).max(30),
    packSize: z.number().int().min(1).max(100_000).optional(),
    hsn: z.string().regex(/^\d{4,8}$/).optional(),
    gstRate: z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28), z.literal(40)]).optional(),
    mrpPaise: z.number().int().min(0).max(1_000_000_000).optional(),
    force: z.boolean().optional(),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/inventory */
export const inventoryRoutes = new Hono<AuthEnv>()
  // #276
  .get('/items', requirePermission('stock.view'), async (c) => {
    const query = itemsQuery.parse(c.req.query());
    return c.json(await listItems(await dbOf(c), query));
  })
  // #277
  .post('/items', requirePermission('inventory.add'), async (c) => {
    const input = newItem.parse(await bodyOf(c));
    const item = await addItem(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'item', recordId: item.id });
    return c.json(item, 201);
  });
