import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { recordCount } from './counts.js';
import { receiveGoods } from './grn.js';
import { issueIndent, requestIndent } from './indents.js';
import { issueStock } from './issues.js';
import { QUARANTINE_REASONS, quarantineStock } from './quarantine.js';
import { ITEM_KINDS } from './items.js';
import { listStock, STOCK_ALERT_KINDS, stockAlerts } from './stock.js';
import { returnToSupplier, SUPPLIER_REFUND_MODES, SUPPLIER_RETURN_REASONS } from './supplier-returns.js';

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

const newIndent = z
  .object({
    ward: z.string().trim().min(1).max(50),
    patientId: z.uuid().optional(),
    lines: z.array(z.object({ itemId: z.uuid(), qty: z.number().int().min(1).max(10_000) }).strict()).min(1).max(50),
  })
  .strict();

const newQuarantine = z
  .object({
    batchId: z.uuid(),
    qty: z.number().int().min(1).max(1_000_000),
    reason: z.enum(QUARANTINE_REASONS),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const alertsQuery = z.object({ kind: z.enum(STOCK_ALERT_KINDS).optional(), withinDays: z.coerce.number().int().min(0).max(730).optional() });

const issueLines = z.array(z.object({ itemId: z.uuid(), batchId: z.uuid(), qty: z.number().int().min(1).max(10_000) }).strict()).min(1).max(50);

const indentIssue = z.object({ patientId: z.uuid(), lines: issueLines }).strict();

const newIssue = z
  .object({ patientId: z.uuid(), encounterId: z.uuid().optional(), admissionId: z.uuid().optional(), surgeryId: z.uuid().optional(), lines: issueLines })
  .strict();

const newCount = z
  .object({
    lines: z.array(z.object({ batchId: z.uuid(), countedQty: z.number().int().min(0).max(1_000_000) }).strict()).min(1).max(500),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const newSupplierReturn = z
  .object({
    supplierId: z.uuid(),
    lines: z.array(z.object({ batchId: z.uuid(), qty: z.number().int().min(1).max(1_000_000) }).strict()).min(1).max(100),
    reason: z.enum(SUPPLIER_RETURN_REASONS),
    creditNoteNo: z.string().trim().min(1).max(50).optional(),
    refundPaise: z.number().int().min(0).max(10_000_000_000),
    refundMode: z.enum(SUPPLIER_REFUND_MODES).optional(),
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
  })
  // #109
  .post('/indents', requirePermission('stock.indent'), async (c) => {
    const input = newIndent.parse(await bodyOf(c));
    const indent = await requestIndent(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { ...(indent.patientId && { patientId: indent.patientId }), recordType: 'indent', recordId: indent.id });
    return c.json(indent, 201);
  })
  // #278
  .post('/indents/:id/issue', requirePermission('stock.issue'), async (c) => {
    const input = indentIssue.parse(await bodyOf(c));
    const result = await issueIndent(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: result.issue.patientId, recordType: 'stock_issue', recordId: result.issue.id });
    return c.json(result);
  })
  // #279
  .post('/issues', requirePermission('stock.issue'), async (c) => {
    const input = newIssue.parse(await bodyOf(c));
    const issue = await issueStock(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: issue.patientId, recordType: 'stock_issue', recordId: issue.id });
    return c.json(issue, 201);
  })
  // #280
  .post('/counts', requirePermission('stock.count'), async (c) => {
    const input = newCount.parse(await bodyOf(c));
    const count = await recordCount(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'stock_count', recordId: count.id });
    return c.json(count, 201);
  })
  // #281
  .post('/supplier-returns', requirePermission('stock.supplier_return'), async (c) => {
    const input = newSupplierReturn.parse(await bodyOf(c));
    const result = await returnToSupplier(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'supplier_return', recordId: result.id });
    return c.json(result, 201);
  })
  // #110
  .post('/quarantine', requirePermission('stock.quarantine'), async (c) => {
    const input = newQuarantine.parse(await bodyOf(c));
    const quarantine = await quarantineStock(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'quarantine', recordId: quarantine.id });
    return c.json(quarantine, 201);
  })
  // #111
  .get('/alerts', requirePermission('stock.view'), async (c) => {
    const query = alertsQuery.parse(c.req.query());
    return c.json(await stockAlerts(await dbOf(c), query));
  });
