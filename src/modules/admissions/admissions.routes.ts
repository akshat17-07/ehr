import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { getPatient } from '../patients/patients.js';
import { admit, getAdmission, listAdmissions, transfer } from './admissions.js';
import { MAR_OUTCOMES, marDay, recordMar } from './mar.js';

// Admissions (api-list.md #69-#73), mounted at /staff/admissions.

export const ward = z.string().trim().min(1).max(50);
export const bed = z.string().trim().min(1).max(20);

const newAdmission = z
  .object({
    patientId: z.uuid(),
    departmentId: z.uuid(),
    doctorId: z.uuid(),
    ward,
    bed,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const listQuery = pageQuery.extend({
  ward: ward.optional(),
  doctorId: z.uuid().optional(),
  current: z.enum(['true', 'false']).optional(),
});

const marQuery = z.object({ date: z.iso.date().optional() });

const newMarEntry = z
  .object({
    prescriptionId: z.uuid(),
    lineIndex: z.number().int().min(0).max(29),
    at: z.iso.datetime({ offset: true }).optional(),
    outcome: z.enum(MAR_OUTCOMES),
    dose: z.string().trim().min(1).max(50).optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((e) => e.outcome === 'given' || e.note !== undefined, { message: 'say why it was held or refused', path: ['note'] });

const transferBody = z
  .object({ version: z.number().int().min(1), ward, bed, reason: z.string().trim().min(1).max(500).optional() })
  .strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const admissionsRoutes = new Hono<AuthEnv>()
  // #70
  .get('/', requirePermission('encounter.view'), async (c) => {
    const { current, ...query } = listQuery.parse(c.req.query());
    return c.json(await listAdmissions(await dbOf(c), { ...query, ...(current && { current: current === 'true' }) }));
  })
  // #69
  .post('/', requirePermission('admission.create'), async (c) => {
    const admission = await admit(await dbOf(c), newAdmission.parse(await bodyOf(c)), userOf(c).sub);
    auditDetails(c, { patientId: admission.patientId, recordType: 'admission', recordId: admission.id });
    return c.json(admission, 201);
  })
  // #71
  .post('/:id/transfer', requirePermission('admission.update'), async (c) => {
    const input = transferBody.parse(await bodyOf(c));
    const admission = await transfer(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: admission.patientId, recordType: 'admission', recordId: admission.id, ...(input.reason && { reason: input.reason }) });
    return c.json(admission);
  })
  // #72: a clinical read, so the inactive-patient rule applies.
  .get('/:id/mar', requirePermission('patient.view'), async (c) => {
    const { date } = marQuery.parse(c.req.query());
    const db = await dbOf(c);
    const admission = await getAdmission(db, c.req.param('id'));
    auditDetails(c, { patientId: admission.patientId, recordType: 'admission', recordId: admission.id });
    await assertPatientAccess(db, userOf(c), await getPatient(db, admission.patientId));
    return c.json(await marDay(db, admission, date));
  })
  // #73
  .post('/:id/mar', requirePermission('mar.record'), async (c) => {
    const input = newMarEntry.parse(await bodyOf(c));
    const db = await dbOf(c);
    const admission = await getAdmission(db, c.req.param('id'));
    const entry = await recordMar(db, admission, input, userOf(c).sub);
    auditDetails(c, { patientId: admission.patientId, recordType: 'mar_entry', recordId: entry.id });
    return c.json(entry, 201);
  });
