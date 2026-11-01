import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { checkIn } from '../appointments/appointments.js';
import { getPatient } from '../patients/patients.js';
import { createEncounter, encounterDetail, ENCOUNTER_STATUSES, ENCOUNTER_TYPES, getEncounter, listEncounters, updateEncounter } from './encounters.js';

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

const encounterChange = z
  .object({
    version: z.number().int().min(1),
    departmentId: z.uuid().optional(),
    doctorId: z.uuid().optional(),
    type: z.enum(ENCOUNTER_TYPES).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
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
  })
  // #38: a clinical read, so the inactive-patient rule applies.
  .get('/:id', requirePermission('encounter.view'), async (c) => {
    const db = await dbOf(c);
    const encounter = await getEncounter(db, c.req.param('id'));
    auditDetails(c, { patientId: encounter.patientId, recordType: 'encounter', recordId: encounter.id });
    await assertPatientAccess(db, userOf(c), await getPatient(db, encounter.patientId));
    return c.json(await encounterDetail(db, encounter));
  })
  // #39
  .patch('/:id', requirePermission('encounter.update'), async (c) => {
    const change = encounterChange.parse(await bodyOf(c));
    const encounter = await updateEncounter(await dbOf(c), c.req.param('id'), change, userOf(c).sub);
    auditDetails(c, { patientId: encounter.patientId, recordType: 'encounter', recordId: encounter.id, reason: change.reason });
    return c.json(encounter);
  });
