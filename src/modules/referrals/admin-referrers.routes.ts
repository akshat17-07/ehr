import { Hono } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { attachReferrerUser, detachReferrerUser, mergeReferrers } from './referrers.js';

const attachBody = z.object({ userId: z.uuid(), reason: z.string().trim().min(5).max(500) }).strict();

const mergeBody = z.object({ intoReferrerId: z.uuid(), reason: z.string().trim().min(5).max(500) }).strict();

const detachBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

// Mounted at /admin/referrers.
export const adminReferrersRoutes = new Hono<AuthEnv>()
  // #201
  .post('/:id/attach-user', requirePermission('referrer.attach_user'), async (c) => {
    const body = attachBody.parse(await c.req.json().catch(() => undefined));
    const referrer = await attachReferrerUser(await dbOf(c), c.req.param('id'), body, userOf(c).sub);
    auditDetails(c, { action: 'update', recordType: 'referrer', recordId: referrer.id, reason: body.reason });
    return c.json(referrer);
  })
  // #202
  .post('/:id/merge', requirePermission('referrer.merge'), async (c) => {
    const body = mergeBody.parse(await c.req.json().catch(() => undefined));
    const { referrer, movedReferralIds, movedPatientIds } = await mergeReferrers(await dbOf(c), c.req.param('id'), body, userOf(c).sub);
    auditDetails(c, { action: 'update', recordType: 'referrer', recordId: referrer.id, changes: { mergedInto: [null, body.intoReferrerId], movedReferralIds: [null, movedReferralIds], movedPatientIds: [null, movedPatientIds] }, reason: body.reason });
    return c.json(referrer);
  })
  // #203
  .post('/:id/detach', requirePermission('referrer.detach'), async (c) => {
    const body = detachBody.parse(await c.req.json().catch(() => undefined));
    const { referrer, oldUserId } = await detachReferrerUser(await dbOf(c), c.req.param('id'), body, userOf(c).sub);
    auditDetails(c, { action: 'update', recordType: 'referrer', recordId: referrer.id, changes: { userId: [oldUserId, null] }, reason: body.reason });
    return c.json(referrer);
  });
