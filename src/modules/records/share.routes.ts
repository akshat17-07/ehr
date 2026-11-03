import { Hono } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, mailerOf, signerOf } from '../../middleware/context.js';
import { sendShareOtp, verifyShareOtp } from './share.js';

const verifyBody = z.object({ otp: z.string().regex(/^\d{6}$/) }).strict();

// Mounted at /other/share. No sign-in: the secret token in the link plus the emailed code are the proof.
export const shareRoutes = new Hono<AuthEnv>()
  // The audit row must never hold the secret token: until a route knows the link, record only the route pattern.
  .use(async (c, next) => {
    const action = c.req.path.endsWith('/verify') ? 'verify' : 'otp';
    auditDetails(c, { recordType: 'share_link', recordId: `${c.req.method} /other/share/:token/${action}` });
    await next();
  })
  // #274
  .post('/:token/otp', async (c) => {
    const sent = await sendShareOtp(await dbOf(c), c.req.param('token'), mailerOf(c));
    auditDetails(c, { patientId: sent.patientId, recordType: 'share_link', recordId: sent.linkId });
    return c.json({ sentTo: sent.sentTo, expiresInSec: sent.expiresInSec });
  })
  // #275
  .post('/:token/verify', async (c) => {
    const body = await c.req.json().catch(() => undefined);
    // The link is looked up first (404 / 410), then the body is checked.
    const done = await verifyShareOtp(await dbOf(c), c.req.param('token'), () => verifyBody.parse(body).otp, signerOf(c));
    auditDetails(c, { action: 'download', patientId: done.patientId, recordType: 'share_link', recordId: done.linkId });
    return c.json({ url: done.url, expiresAt: done.expiresAt });
  });
