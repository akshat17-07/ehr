import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import { breakGlass } from '../access/break-glass.js';
import { assertPatientAccess } from '../access/patient-access.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { indiaDate } from '../../time/india.js';
import {
  getPatient,
  listPatientVersions,
  registerEmergency,
  registerPatient,
  searchPatients,
  SEXES,
  updatePatient,
} from './patients.js';
import { CONSENT_KINDS, LANGUAGES, recordConsent } from './consents.js';
import { patientObservations } from '../encounters/observations.js';
import { patientVitals } from '../encounters/vitals.js';
import { addAllergy, ALLERGY_SEVERITIES, listAllergies } from './allergies.js';
import { addGuardian } from './guardians.js';
import { addProblem, listProblems } from './problems.js';
import { addAncRecord, listAncRecords } from '../departments/anc.js';
import { addDentalEntries, dentalChart, FDI_TOOTH, TOOTH_SURFACES } from '../departments/dental.js';
import { patientPrescriptions, RX_STATUSES } from '../prescriptions/prescriptions.js';
import { DOCUMENT_TYPES, patientDocuments } from '../documents/documents.js';
import { patientTimeline, TIMELINE_KINDS } from './timeline.js';
import { DEPOSIT_MODES, patientDeposits, takeDeposit } from '../billing/deposits.js';

// /staff/patients (api-list.md 6.3).

const searchQuery = pageQuery.extend({ q: z.string().trim().min(1).max(100) });

// Indian mobile numbers: 10 digits starting 6-9 (a +91 or 0 in front is dropped).
const mobile = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|0)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'a 10-digit Indian mobile number'));

const name = z.string().trim().min(2).max(100);
const text = z.string().trim().min(1).max(200);
const relation = z.string().trim().min(2).max(50);

const address = z
  .object({
    line1: text,
    line2: text.optional(),
    city: text,
    district: text,
    state: text,
    pincode: z.string().regex(/^[1-9]\d{5}$/, 'a 6-digit PIN code'),
  })
  .strict();

const pastDate = z.iso.date().refine((d) => d <= indiaDate(), 'not in the future');

const newPatient = z
  .object({
    name,
    sex: z.enum(SEXES),
    dob: pastDate.optional(),
    ageYears: z.number().int().min(0).max(130).optional(),
    mobile: mobile.optional(),
    email: z.email().max(254).optional(),
    address: address.optional(),
    guardian: z.object({ name, relation, mobile: mobile.optional() }).strict().optional(),
  })
  .strict()
  .refine((p) => (p.dob === undefined) !== (p.ageYears === undefined), { message: 'give dob or ageYears (one of them)', path: ['dob'] });

const patientChange = z
  .object({
    version: z.number().int().min(1),
    name: name.optional(),
    sex: z.enum(SEXES).optional(),
    dob: pastDate.optional(),
    ageYears: z.number().int().min(0).max(130).optional(),
    mobile: mobile.nullable().optional(),
    email: z.email().max(254).nullable().optional(),
    address: address.nullable().optional(),
    unknown: z.literal(false).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .refine((p) => p.dob === undefined || p.ageYears === undefined, { message: 'give dob or ageYears, not both', path: ['dob'] });

const newGuardian = z
  .object({
    name,
    relation,
    mobile: mobile.optional(),
    guardianPatientId: z.uuid().optional(),
    portalAccess: z.boolean().optional(),
  })
  .strict();

const newConsent = z
  .object({
    kind: z.enum(CONSENT_KINDS),
    noticeVersion: z.string().trim().min(1).max(50).optional(),
    language: z.enum(LANGUAGES),
    given: z.boolean(),
    documentId: z.uuid().optional(),
  })
  .strict();

const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

const rangeQuery = pageQuery.extend({ from: z.iso.date().optional(), to: z.iso.date().optional() });

const newDentalEntries = z
  .object({
    encounterId: z.uuid().optional(),
    entries: z
      .array(
        z
          .object({
            tooth: z.string().regex(FDI_TOOTH, 'an FDI tooth number, e.g. 36'),
            surface: z.string().trim().toUpperCase().regex(TOOTH_SURFACES, 'surface letters M D O B L I P').optional(),
            condition: z.string().trim().min(1).max(100),
            treatment: z.string().trim().min(1).max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(52),
  })
  .strict();

const isoDate = z.iso.date();
const newAncRecord = z
  .object({
    encounterId: z.uuid().optional(),
    lmp: isoDate.optional(),
    edd: isoDate.optional(),
    gravida: z.number().int().min(1).max(20).optional(),
    para: z.number().int().min(0).max(20).optional(),
    gestationWeeks: z.number().int().min(1).max(45).optional(),
    bp: z.string().trim().regex(/^\d{2,3}\/\d{2,3}$/, 'like 120/80').optional(),
    weightKg: z.number().min(20).max(250).optional(),
    fundalHeightCm: z.number().min(5).max(60).optional(),
    fhr: z.number().int().min(60).max(220).optional(),
    notes: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).some((k) => k !== 'encounterId'), 'record at least one finding')
  .refine((b) => b.para === undefined || b.gravida === undefined || b.para < b.gravida, 'para: must be less than gravida');

const prescriptionsQuery = rangeQuery.extend({ status: z.enum(RX_STATUSES).optional() });

const documentsQuery = rangeQuery.extend({ type: z.enum(DOCUMENT_TYPES).optional(), includeMisfiled: z.enum(['true', 'false']).optional() });

const observationsQuery = rangeQuery.extend({ loinc: z.string().trim().min(1).max(20).optional() });

const allergiesQuery = z.object({ includeVoid: z.enum(['true', 'false']).optional() });
const newAllergy = z
  .object({
    substance: z.string().trim().min(2).max(100),
    drugId: z.uuid().optional(),
    reaction: z.string().trim().min(1).max(200).optional(),
    severity: z.enum(ALLERGY_SEVERITIES),
  })
  .strict();

const problemsQuery = z.object({ active: z.enum(['true', 'false']).optional() });
const newProblem = z
  .object({
    text: z.string().trim().min(2).max(500),
    icd10: z.string().trim().regex(/^[A-Za-z]\d{2}(\.\w{1,4})?$/, 'an ICD-10 code looks like J18.9').optional(),
    onset: z.iso.date().optional(),
  })
  .strict();

const timelineQuery = pageQuery.extend({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  kind: z.enum(TIMELINE_KINDS).optional(),
});

const newDeposit = z
  .object({
    amountPaise: z.number().int().min(100).max(100_000_000),
    mode: z.enum(DEPOSIT_MODES),
    reference: z.string().trim().min(1).max(100).optional(),
  })
  .strict()
  .refine((d) => d.mode === 'cash' || d.reference, { message: 'the UPI or card reference is needed', path: ['reference'] });

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

const emergencyPatient = z
  .object({
    sex: z.enum(SEXES).optional(),
    approxAgeYears: z.number().int().min(0).max(130).optional(),
    description: z.string().trim().min(3).max(1000),
    broughtBy: text.optional(),
  })
  .strict();

export const patientsRoutes = new Hono<AuthEnv>()
  // #19
  .get('/', requirePermission('patient.search'), async (c) => {
    const query = searchQuery.parse(c.req.query());
    return c.json(await searchPatients(await dbOf(c), query));
  })
  // #20
  .post('/', requirePermission('patient.register'), async (c) => {
    const input = newPatient.parse(await bodyOf(c));
    const patient = await registerPatient(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    return c.json(patient, 201);
  })
  // #21
  .post('/emergency', requirePermission('patient.register'), async (c) => {
    const input = emergencyPatient.parse(await bodyOf(c));
    const patient = await registerEmergency(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    return c.json(patient, 201);
  })
  // #22
  .get('/:id', requirePermission('patient.view'), async (c) => {
    const patient = await getPatient(await dbOf(c), c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    return c.json(patient);
  })
  // #23
  .patch('/:id', requirePermission('patient.update'), async (c) => {
    const change = patientChange.parse(await bodyOf(c));
    const patient = await updatePatient(await dbOf(c), c.req.param('id'), change, userOf(c).sub);
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id, reason: change.reason });
    return c.json(patient);
  })
  // #24
  .get('/:id/versions', requirePermission('patient.view'), async (c) => {
    const id = c.req.param('id');
    const versions = await listPatientVersions(await dbOf(c), id);
    auditDetails(c, { patientId: id, recordType: 'patient', recordId: id });
    return c.json(versions);
  })
  // #25
  .get('/:id/timeline', requirePermission('patient.view'), async (c) => {
    const query = timelineQuery.parse(c.req.query());
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await patientTimeline(db, patient.id, query));
  })
  // #42
  .get('/:id/vitals', requirePermission('patient.view'), async (c) => {
    const query = rangeQuery.parse(c.req.query());
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await patientVitals(db, patient.id, query));
  })
  // #44
  .get('/:id/observations', requirePermission('patient.view'), async (c) => {
    const query = observationsQuery.parse(c.req.query());
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await patientObservations(db, patient.id, query));
  })
  // #52: allergies are safety information, so the inactive-patient rule does not hide them.
  .get('/:id/allergies', requirePermission('patient.view'), async (c) => {
    const { includeVoid } = allergiesQuery.parse(c.req.query());
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    return c.json(await listAllergies(db, patient.id, includeVoid === 'true'));
  })
  // #53
  .post('/:id/allergies', requirePermission('allergy.write'), async (c) => {
    const input = newAllergy.parse(await bodyOf(c));
    const allergy = await addAllergy(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: allergy.patientId, recordType: 'allergy', recordId: allergy.id });
    return c.json(allergy, 201);
  })
  // #77: a clinical read, so the inactive-patient rule applies.
  .get('/:id/dental-chart', requirePermission('dept.dental'), async (c) => {
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await dentalChart(db, patient.id));
  })
  // #78
  .post('/:id/dental-chart', requirePermission('dept.dental'), async (c) => {
    const input = newDentalEntries.parse(await bodyOf(c));
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    const entries = await addDentalEntries(db, patient.id, input, userOf(c).sub);
    auditDetails(c, { patientId: patient.id, recordType: 'dental_entry', recordId: entries[0]?.id ?? patient.id });
    return c.json(entries, 201);
  })
  // #79: a clinical read, so the inactive-patient rule applies.
  .get('/:id/anc-records', requirePermission('dept.anc'), async (c) => {
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await listAncRecords(db, patient.id));
  })
  // #80
  .post('/:id/anc-records', requirePermission('dept.anc'), async (c) => {
    const input = newAncRecord.parse(await bodyOf(c));
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    const record = await addAncRecord(db, patient.id, input, userOf(c).sub);
    auditDetails(c, { patientId: patient.id, recordType: 'anc_record', recordId: record.id });
    return c.json(record, 201);
  })
  // #67: a clinical read, so the inactive-patient rule applies.
  .get('/:id/prescriptions', requirePermission('rx.view'), async (c) => {
    const query = prescriptionsQuery.parse(c.req.query());
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await patientPrescriptions(db, patient.id, query));
  })
  // #96: a clinical read, so the inactive-patient rule applies.
  .get('/:id/documents', requirePermission('document.view'), async (c) => {
    const query = documentsQuery.parse(c.req.query());
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await patientDocuments(db, patient.id, query));
  })
  // #55: a clinical read, so the inactive-patient rule applies.
  .get('/:id/problems', requirePermission('patient.view'), async (c) => {
    const { active } = problemsQuery.parse(c.req.query());
    const db = await dbOf(c);
    const patient = await getPatient(db, c.req.param('id'));
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    await assertPatientAccess(db, userOf(c), patient);
    return c.json(await listProblems(db, patient.id, active === undefined ? undefined : active === 'true'));
  })
  // #56
  .post('/:id/problems', requirePermission('problem.write'), async (c) => {
    const input = newProblem.parse(await bodyOf(c));
    const problem = await addProblem(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: problem.patientId, recordType: 'problem', recordId: problem.id });
    return c.json(problem, 201);
  })
  // #26
  .post('/:id/guardians', requirePermission('patient.update'), async (c) => {
    const input = newGuardian.parse(await bodyOf(c));
    const id = c.req.param('id');
    const guardian = await addGuardian(await dbOf(c), id, input, userOf(c).sub);
    auditDetails(c, { patientId: guardian.patientId, recordType: 'guardian', recordId: guardian.id });
    return c.json(guardian, 201);
  })
  // #27
  .post('/:id/consents', requirePermission('patient.update'), async (c) => {
    const input = newConsent.parse(await bodyOf(c));
    const consent = await recordConsent(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: consent.patientId, recordType: 'consent', recordId: consent.id });
    return c.json(consent, 201);
  })
  // #127
  .get('/:id/deposits', requirePermission('bill.view'), async (c) => {
    const id = c.req.param('id');
    const deposits = await patientDeposits(await dbOf(c), id);
    auditDetails(c, { patientId: id, recordType: 'patient', recordId: id });
    return c.json(deposits);
  })
  // #126
  .post('/:id/deposits', requirePermission('deposit.create'), async (c) => {
    const input = newDeposit.parse(await bodyOf(c));
    const deposit = await takeDeposit(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: deposit.patientId, recordType: 'deposit', recordId: deposit.id });
    return c.json(deposit, 201);
  })
  // #30
  .post('/:id/break-glass', requirePermission('breakglass.invoke'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const event = await breakGlass(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: event.patientId, recordType: 'break_glass_event', recordId: event.id, reason });
    return c.json(event, 201);
  });
