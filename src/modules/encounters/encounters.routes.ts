import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { assertPermission, requirePermission } from '../../permissions/check.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { writeSummary } from '../admissions/discharge.js';
import { summaryFields } from '../admissions/discharge.routes.js';
import { checkIn } from '../appointments/appointments.js';
import { getFormF } from '../departments/form-f.js';
import { getPatient } from '../patients/patients.js';
import { writePrescription } from '../prescriptions/prescriptions.js';
import { acknowledgedAlerts, rxLines } from '../prescriptions/prescriptions.routes.js';
import { addDiagnosis, DIAGNOSIS_KINDS } from './diagnoses.js';
import { addNote, addNursingNote, NOTE_KINDS, SHIFTS } from './notes.js';
import { noteText } from './notes.routes.js';
import { recordObservation } from './observations.js';
import { addOrder, ORDER_KINDS } from './orders.js';
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

const newDiagnosis = z
  .object({
    icd10: z.string().trim().regex(/^[A-Za-z]\d{2}(\.\w{1,4})?$/, 'an ICD-10 code looks like J18.9'),
    text: z.string().trim().min(1).max(500),
    kind: z.enum(DIAGNOSIS_KINDS),
  })
  .strict();
const newOrder = z
  .object({
    kind: z.enum(ORDER_KINDS),
    code: z.string().trim().min(1).max(30).optional(),
    name: z.string().trim().min(2).max(200),
    notes: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
const newSummary = z.object(summaryFields).strict();
const newPrescription = z.object({ lines: rxLines, acknowledgedAlerts }).strict();
const newNursingNote = z.object({ text: noteText, shift: z.enum(SHIFTS).optional() }).strict();
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
  })
  // #49
  .post('/:id/nursing-notes', requirePermission('nursing_note.write'), async (c) => {
    const input = newNursingNote.parse(await bodyOf(c));
    const note = await addNursingNote(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: note.patientId, recordType: 'note', recordId: note.id });
    return c.json(note, 201);
  })
  // #50
  .post('/:id/diagnoses', requirePermission('diagnosis.write'), async (c) => {
    const input = newDiagnosis.parse(await bodyOf(c));
    const diagnosis = await addDiagnosis(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: diagnosis.patientId, recordType: 'diagnosis', recordId: diagnosis.id });
    return c.json(diagnosis, 201);
  })
  // #58
  .post('/:id/orders', requirePermission('order.write'), async (c) => {
    const input = newOrder.parse(await bodyOf(c));
    const order = await addOrder(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: order.patientId, recordType: 'order', recordId: order.id });
    return c.json(order, 201);
  })
  // #62
  .post('/:id/prescriptions', requirePermission('rx.write'), async (c) => {
    const input = newPrescription.parse(await bodyOf(c));
    const prescription = await writePrescription(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: prescription.patientId, recordType: 'prescription', recordId: prescription.id });
    return c.json(prescription, 201);
  })
  // #74
  .post('/:id/discharge-summary', requirePermission('discharge.write'), async (c) => {
    const input = newSummary.parse(await bodyOf(c));
    const summary = await writeSummary(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: summary.patientId, recordType: 'discharge_summary', recordId: summary.id });
    return c.json(summary, 201);
  })
  // #81: PC-PNDT access comes from a grant, for all, the encounter's department or this patient.
  .get('/:id/form-f', async (c) => {
    const db = await dbOf(c);
    const encounter = await getEncounter(db, c.req.param('id'));
    await assertPermission(c, 'pcpndt.view', { patientId: encounter.patientId, departmentIds: [encounter.departmentId] });
    auditDetails(c, { patientId: encounter.patientId, recordType: 'encounter', recordId: encounter.id });
    await assertPatientAccess(db, userOf(c), await getPatient(db, encounter.patientId));
    return c.json(await getFormF(db, encounter.id));
  });
