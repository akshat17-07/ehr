import { Hono } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { getBill } from './bills.js';
import { decideDiscount } from './discounts.js';
import { decideRefund } from './refunds.js';

// /admin/refunds and /admin/discounts: a second person decides what was over the hospital's limit.

const approveBody = z.object({ note: z.string().trim().min(1).max(500).optional() }).strict();
const rejectBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

export const adminRefundsRoutes = new Hono<AuthEnv>()
  // #177
  .post('/:id/approve', requirePermission('approval.refund'), async (c) => {
    const body = approveBody.parse(await c.req.json().catch(() => ({})));
    const refund = await decideRefund(await dbOf(c), c.req.param('id'), { approve: true, ...(body.note && { note: body.note }) }, userOf(c).sub);
    auditDetails(c, { action: 'update', patientId: refund.patientId, recordType: 'refund', recordId: refund.id, ...(body.note && { reason: body.note }) });
    return c.json(refund);
  })
  // #178
  .post('/:id/reject', requirePermission('approval.refund'), async (c) => {
    const body = rejectBody.parse(await c.req.json().catch(() => undefined));
    const refund = await decideRefund(await dbOf(c), c.req.param('id'), { approve: false, reason: body.reason }, userOf(c).sub);
    auditDetails(c, { action: 'update', patientId: refund.patientId, recordType: 'refund', recordId: refund.id, reason: body.reason });
    return c.json(refund);
  });

export const adminDiscountsRoutes = new Hono<AuthEnv>()
  // #179
  .post('/:id/approve', requirePermission('approval.discount'), async (c) => {
    const body = approveBody.parse(await c.req.json().catch(() => ({})));
    const discount = await decideDiscount(await dbOf(c), c.req.param('id'), { approve: true, ...(body.note && { note: body.note }) }, userOf(c).sub);
    auditDetails(c, { action: 'update', patientId: (await getBill(await dbOf(c), discount.billId)).patientId, recordType: 'discount', recordId: discount.id, ...(body.note && { reason: body.note }) });
    return c.json(discount);
  })
  // #180
  .post('/:id/reject', requirePermission('approval.discount'), async (c) => {
    const body = rejectBody.parse(await c.req.json().catch(() => undefined));
    const discount = await decideDiscount(await dbOf(c), c.req.param('id'), { approve: false, reason: body.reason }, userOf(c).sub);
    auditDetails(c, { action: 'update', patientId: (await getBill(await dbOf(c), discount.billId)).patientId, recordType: 'discount', recordId: discount.id, reason: body.reason });
    return c.json(discount);
  });
