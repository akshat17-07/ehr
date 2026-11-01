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
import { addGuardian } from './guardians.js';
import { patientTimeline, TIMELINE_KINDS } from './timeline.js';

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
  })
  .strict();

const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

const timelineQuery = pageQuery.extend({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  kind: z.enum(TIMELINE_KINDS).optional(),
});

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
  // #30
  .post('/:id/break-glass', requirePermission('breakglass.invoke'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const event = await breakGlass(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: event.patientId, recordType: 'break_glass_event', recordId: event.id, reason });
    return c.json(event, 201);
  });
