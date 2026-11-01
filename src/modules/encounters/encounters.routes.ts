import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { checkIn } from '../appointments/appointments.js';
import { createEncounter, ENCOUNTER_STATUSES, ENCOUNTER_TYPES, listEncounters } from './encounters.js';

// Encounters (api-list.md #36-#40), mounted at /staff/encounters.

const listQuery = pageQuery.extend({
  date: z.iso.date().optional(),
  doctorId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  type: z.enum(ENCOUNTER_TYPES).optional(),
  status: z.enum(ENCOUNTER_STATUSES).optional(),
});

const newEncounter = z
  .object({
    patientId: z.uuid(),
    type: z.enum(ENCOUNTER_TYPES),
    departmentId: z.uuid(),
    doctorId: z.uuid(),
    appointmentId: z.uuid().optional(),
  })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const encountersRoutes = new Hono<AuthEnv>()
  // #36
  .get('/', requirePermission('encounter.view'), async (c) => c.json(await listEncounters(await dbOf(c), listQuery.parse(c.req.query()))))
  // #37: with an appointment it is that appointment's check-in (#34), which also marks it arrived.
  .post('/', requirePermission('encounter.create'), async (c) => {
    const { appointmentId, ...visit } = newEncounter.parse(await bodyOf(c));
    const db = await dbOf(c);
    const by = userOf(c).sub;
    const encounter = appointmentId
      ? (await checkIn(db, appointmentId, by, new Date(), visit)).encounter
      : await createEncounter(db, visit, by);
    auditDetails(c, { patientId: encounter.patientId, recordType: 'encounter', recordId: encounter.id });
    return c.json(encounter, 201);
  });
