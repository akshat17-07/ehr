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
import { addNote, NOTE_KINDS } from './notes.js';
import { recordObservation } from './observations.js';
import { recordVital, VITAL_FIELDS, type VitalField } from './vitals.js';
import { closeEncounter, createEncounter, encounterDetail, ENCOUNTER_STATUSES, ENCOUNTER_TYPES, getEncounter, listEncounters, updateEncounter } from './encounters.js';

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

const newVital = z
  .object({
    takenAt: z.iso.datetime({ offset: true }).optional(),
    ...(Object.fromEntries(VITAL_FIELDS.map(([field, , min, max]) => [field, z.number().min(min).max(max).optional()])) as Record<
      VitalField,
      z.ZodOptional<z.ZodNumber>
    >),
  })
  .strict()
  .refine((v) => VITAL_FIELDS.some(([field]) => v[field] !== undefined), 'at least one reading is needed')
  .refine((v) => (v.bpSys === undefined) === (v.bpDia === undefined), 'bpSys and bpDia go together')
  .refine((v) => v.bpSys === undefined || v.bpDia === undefined || v.bpDia < v.bpSys, 'bpDia must be below bpSys');

const newObservation = z
  .object({
    loinc: z.string().trim().regex(/^\d{1,7}-\d$/, 'a LOINC code looks like 8867-4'),
    name: z.string().trim().min(1).max(200),
    value: z.union([z.number().finite(), z.string().trim().min(1).max(500)]),
    unit: z.string().trim().min(1).max(30).optional(),
    takenAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

const noteText = z.string().trim().min(1).max(20_000);
const newNote = z.object({ kind: z.enum(NOTE_KINDS).exclude(['nursing']), text: noteText }).strict();

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
  })
  // #40
  .post('/:id/close', requirePermission('encounter.update'), async (c) => {
    const encounter = await closeEncounter(await dbOf(c), c.req.param('id'), userOf(c).sub);
    auditDetails(c, { patientId: encounter.patientId, recordType: 'encounter', recordId: encounter.id });
    return c.json(encounter);
  })
  // #41
  .post('/:id/vitals', requirePermission('vitals.record'), async (c) => {
    const input = newVital.parse(await bodyOf(c));
    const vital = await recordVital(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: vital.patientId, recordType: 'vital', recordId: vital.id });
    return c.json(vital, 201);
  })
  // #43
  .post('/:id/observations', requirePermission('observation.record'), async (c) => {
    const input = newObservation.parse(await bodyOf(c));
    const observation = await recordObservation(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: observation.patientId, recordType: 'observation', recordId: observation.id });
    return c.json(observation, 201);
  })
  // #45
  .post('/:id/notes', requirePermission('note.write'), async (c) => {
    const input = newNote.parse(await bodyOf(c));
    const note = await addNote(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: note.patientId, recordType: 'note', recordId: note.id });
    return c.json(note, 201);
  });
