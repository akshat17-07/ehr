import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { address, mobile } from '../patients/patients.routes.js';
import { portalProfiles, resolvePortalPatient } from './portal-access.js';
import { portalHome, updatePortalProfile } from './portal.js';

// /patient (api-list.md §8): own record or a linked family member only, resolved by resolvePortalPatient.
// No permission keys: the patient pool (requireUser('patient') in app.ts) is the gate.

const patientQuery = z.object({ patientId: z.string().max(100).optional() });

// Contact details only: name, sex and DOB are corrected by the staff (#258). Same checks as the staff edit (#23).
const profileChange = z
  .object({
    version: z.number().int().min(1),
    mobile: mobile.nullable().optional(),
    email: z.email().max(254).nullable().optional(),
    address: address.nullable().optional(),
  })
  .strict();

const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const portalRoutes = new Hono<AuthEnv>()
  // #239
  .get('/profiles', async (c) => {
    const profiles = await portalProfiles(await dbOf(c), userOf(c).sub);
    auditDetails(c, { patientId: profiles[0]?.patientId });
    return c.json(profiles);
  })
  // #240
  .patch('/profile', async (c) => {
    const { patientId } = patientQuery.parse(c.req.query());
    const profile = await resolvePortalPatient(c, patientId);
    const change = profileChange.parse(await bodyOf(c));
    const patient = await updatePortalProfile(await dbOf(c), profile.patientId, change, userOf(c).sub);
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id, reason: 'patient portal' });
    return c.json(patient);
  })
  // #241
  .get('/home', async (c) => {
    const { patientId } = patientQuery.parse(c.req.query());
    const profile = await resolvePortalPatient(c, patientId);
    return c.json(await portalHome(await dbOf(c), profile.patientId));
  });
