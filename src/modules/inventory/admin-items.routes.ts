import { Hono } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { changeItem, listAdminItems, setReorderSettings } from './admin-items.js';
import { ITEM_KINDS } from './items.js';

const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
const itemsQuery = pageQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  active: flag.optional(),
  noReorderSettings: flag.optional(),
});

const itemChange = z
  .object({
    version: z.number().int().min(1),
    name: z.string().trim().min(2).max(200).optional(),
    unit: z.string().trim().min(1).max(30).optional(),
    packSize: z.number().int().min(1).max(100_000).optional(),
    hsn: z.string().regex(/^\d{4,8}$/).optional(),
    gstRate: z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28), z.literal(40)]).optional(),
    mrpPaise: z.number().int().min(0).max(1_000_000_000).optional(),
    active: z.boolean().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

const days = z.number().int().min(0).max(365);
const qty = z.number().int().min(0).max(100_000_000);
export const reorderBody = z
  .object({
    version: z.number().int().min(1).optional(),
    reorderLevel: qty.optional(),
    minLevel: qty.optional(),
    reorderQty: qty.optional(),
    maxLevel: qty.optional(),
    leadTimeDays: days.optional(),
    safetyDays: days.optional(),
    preferredSupplierId: z.uuid().optional(),
  })
  .strict();

/** /admin/inventory */
export const adminInventoryRoutes = new Hono<AuthEnv>()
  // #350
  .get('/items', requirePermission('inventory.manage'), async (c) => {
    const query = itemsQuery.parse(c.req.query());
    return c.json(await listAdminItems(await dbOf(c), query));
  })
  // #351
  .patch('/items/:id', requirePermission('inventory.manage'), async (c) => {
    const input = itemChange.parse(await c.req.json().catch(() => undefined));
    const { item, changes } = await changeItem(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { recordType: 'item', recordId: item.id, changes, ...(input.reason && { reason: input.reason }) });
    return c.json(item);
  })
  // #352
  .put('/items/:id/reorder-settings', requirePermission('inventory.manage'), async (c) => {
    const input = reorderBody.parse(await c.req.json().catch(() => undefined));
    const { setting, changes } = await setReorderSettings(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { recordType: 'reorder_setting', recordId: setting.itemId, changes });
    return c.json(setting);
  });
