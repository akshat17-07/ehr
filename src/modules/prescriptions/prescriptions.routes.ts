import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { getPatient } from '../patients/patients.js';
import { getPrescription, voidPrescription } from './prescriptions.js';
import { checkLines } from './rx-checks.js';

// Prescriptions by id (api-list.md #64-#68), mounted at /staff/prescriptions. They are written in an encounter (#62).

const short = (max: number) => z.string().trim().min(1).max(max);

export const rxLine = z
  .object({
    drugId: z.uuid().optional(),
    drugText: z.string().trim().min(2).max(200),
    strength: short(50).optional(),
    form: short(50).optional(),
    dose: short(50),
    frequency: short(50),
    route: short(30).optional(),
    days: z.number().int().min(1).max(365),
    quantity: z.number().int().min(1).max(10_000).optional(),
    instructions: short(500).optional(),
  })
  .strict();
export const rxLines = z.array(rxLine).min(1).max(30);
export const acknowledgedAlerts = z.array(z.string().max(40)).max(100).optional();

const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
const checkBody = z.object({ patientId: z.uuid(), lines: rxLines }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const prescriptionsRoutes = new Hono<AuthEnv>()
  // #65: the alerts while the doctor types, before saving.
  .post('/check', requirePermission('rx.write'), async (c) => {
    const { patientId, lines } = checkBody.parse(await bodyOf(c));
    const db = await dbOf(c);
    const patient = await getPatient(db, patientId);
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id });
    return c.json({ alerts: await checkLines(db, patient.id, lines) });
  })
  // #66: a clinical read, so the inactive-patient rule applies.
  .get('/:id', requirePermission('rx.view'), async (c) => {
    const db = await dbOf(c);
    const prescription = await getPrescription(db, c.req.param('id'));
    auditDetails(c, { patientId: prescription.patientId, recordType: 'prescription', recordId: prescription.id });
    await assertPatientAccess(db, userOf(c), await getPatient(db, prescription.patientId));
    return c.json(prescription);
  })
  // #68
  .post('/:id/void', requirePermission('rx.write'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const prescription = await voidPrescription(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: prescription.patientId, recordType: 'prescription', recordId: prescription.id, reason });
    return c.json(prescription);
  });
