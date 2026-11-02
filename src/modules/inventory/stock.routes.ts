import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { receiveGoods } from './grn.js';
import { ITEM_KINDS } from './items.js';
import { listStock } from './stock.js';

const stockQuery = pageQuery.extend({
  itemId: z.uuid().optional(),
  kind: z.enum(ITEM_KINDS).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

const paise = z.number().int().min(0).max(100_000_000);

const newGrn = z
  .object({
    supplierId: z.uuid(),
    purchaseOrderId: z.uuid().optional(),
    invoiceNo: z.string().trim().min(1).max(50),
    invoiceDate: z.iso.date(),
    lines: z
      .array(
        z
          .object({
            itemId: z.uuid(),
            batchNo: z.string().trim().min(1).max(50),
            expiry: z.iso.date(),
            qty: z.number().int().min(1).max(1_000_000),
            freeQty: z.number().int().min(0).max(1_000_000).optional(),
            costPaise: paise,
            mrpPaise: paise,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/stock */
export const stockRoutes = new Hono<AuthEnv>()
  // #107
  .get('/', requirePermission('stock.view'), async (c) => {
    const query = stockQuery.parse(c.req.query());
    return c.json(await listStock(await dbOf(c), query));
  })
  // #108
  .post('/grn', requirePermission('stock.receive'), async (c) => {
    const input = newGrn.parse(await bodyOf(c));
    const grn = await receiveGoods(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'grn', recordId: grn.id });
    return c.json(grn, 201);
  });
