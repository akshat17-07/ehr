import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
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
    guardian: z.object({ name, relation: z.string().trim().min(2).max(50), mobile: mobile.optional() }).strict().optional(),
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
  });
