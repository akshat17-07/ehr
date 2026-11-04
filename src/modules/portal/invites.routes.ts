import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf, mailerOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { getPatient } from '../patients/patients.js';
import { mobile } from '../patients/patients.routes.js';
import { acceptPortalInvite, createPortalInvite, getPortalInvite, INVITE_CHANNELS, listPortalInvites, revokePortalInvite } from './invites.js';

const bodyOf = (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => undefined);

const newInvite = z.object({ channel: z.enum(INVITE_CHANNELS), to: z.string().trim().min(1).max(254).optional() }).strict();

/** Staff routes under /staff/patients/:id/portal-invites (#409, #410); mounted by patients.routes.ts. */
export const patientInviteRoutes = new Hono<AuthEnv>()
  // #409
  .post('/:id/portal-invites', requirePermission('portal.invite'), async (c) => {
    const input = newInvite.parse(await bodyOf(c));
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'portal_invite' });
    await assertPatientAccess(db, userOf(c), patient);
    const to = input.to === undefined ? undefined : input.channel === 'email' ? z.email().max(254).parse(input.to) : mobile.parse(input.to);
    const done = await createPortalInvite(db, patient.id, { channel: input.channel, to }, userOf(c).sub, mailerOf(c));
    auditDetails(c, { patientId: done.invite.patientId, recordType: 'portal_invite', recordId: done.invite.id });
    return c.json(done, 201);
  })
  // #410
  .get('/:id/portal-invites', requirePermission('portal.invite'), async (c) => {
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'portal_invite' });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await listPortalInvites(db, patient.id));
  });

/** Mounted at /staff/portal-invites. */
export const staffInviteRoutes = new Hono<AuthEnv>()
  // #411
  .post('/:id/revoke', requirePermission('portal.invite'), async (c) => {
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(await bodyOf(c));
    const db = await dbOf(c);
    const existing = await getPortalInvite(db, c.req.param('id'));
    const patient = await getPatient(db, existing.patientId);
    auditDetails(c, { patientId: patient.id, recordType: 'portal_invite', recordId: existing.id, reason });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await revokePortalInvite(db, existing.id, reason, userOf(c).sub));
  });

/** Mounted at /patient/invites, before the portal routes: a sign-in with no patient link yet may call it. */
export const patientAcceptRoutes = new Hono<AuthEnv>()
  // #412
  .post('/accept', async (c) => {
    const { token } = z.object({ token: z.string().min(1).max(200) }).strict().parse(await bodyOf(c));
    const user = userOf(c);
    // The audit row must never hold the secret token.
    auditDetails(c, { recordType: 'portal_invite' });
    const profiles = await acceptPortalInvite(await dbOf(c), token, user.sub, user.email);
    auditDetails(c, { patientId: profiles[0]?.patientId, recordType: 'portal_invite' });
    return c.json({ profiles });
  });
