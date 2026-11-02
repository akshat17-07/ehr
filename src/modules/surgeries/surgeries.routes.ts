import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { addImplant, surgeryImplants } from '../departments/implants.js';
import { getPatient } from '../patients/patients.js';
import { CHECKLIST_ITEMS, getSurgery, listSurgeries, planSurgery, recordChecklist, updateSurgery, SIDES, SURGERY_STATUSES, VENUES } from './surgeries.js';

const listQuery = z
  .object({ from: z.iso.date(), to: z.iso.date(), surgeonId: z.uuid().optional(), status: z.enum(SURGERY_STATUSES).optional() })
  .strict();

// consentDocumentIds come with documents (#211).
const newSurgery = z
  .object({
    patientId: z.uuid(),
    procedure: z.string().trim().min(3).max(200),
    site: z.string().trim().min(1).max(100).optional(),
    side: z.enum(SIDES).optional(),
    surgeonId: z.uuid(),
    teamIds: z.array(z.uuid()).max(15).optional(),
    scheduledAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
    venue: z.enum(VENUES),
    partnerHospitalId: z.uuid().optional(),
    chargesPaise: z.number().int().min(0).max(10_000_000_000),
    instructions: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

// stickerDocumentId comes with documents (#211).
const newImplant = z
  .object({
    name: z.string().trim().min(2).max(200),
    manufacturer: z.string().trim().min(1).max(200).optional(),
    batchNo: z.string().trim().min(1).max(50),
    size: z.string().trim().min(1).max(50).optional(),
    mrpPaise: z.number().int().min(0).max(10_000_000_000),
  })
  .strict();

// consentDocumentIds come with documents (#211).
const surgeryChange = z
  .object({
    version: z.number().int().min(1),
    scheduledAt: z.iso.datetime({ offset: true }).transform((s) => new Date(s)).optional(),
    teamIds: z.array(z.uuid()).max(15).optional(),
    venue: z.enum(VENUES).optional(),
    partnerHospitalId: z.uuid().optional(),
    chargesPaise: z.number().int().min(0).max(10_000_000_000).optional(),
    instructions: z.string().trim().min(1).max(2000).optional(),
    reason: z.string().trim().min(5).max(500).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).some((k) => k !== 'version' && k !== 'reason'), 'change at least one field');

/** Every item of the phase, yes or no. */
const phase = (items: readonly string[]) => z.object(Object.fromEntries(items.map((k) => [k, z.boolean()]))).strict();
const checklist = z
  .object({ signIn: phase(CHECKLIST_ITEMS.signIn), timeOut: phase(CHECKLIST_ITEMS.timeOut), signOut: phase(CHECKLIST_ITEMS.signOut) })
  .partial()
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'record at least one phase');

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/surgeries */
export const surgeriesRoutes = new Hono<AuthEnv>()
  // #86
  .get('/', requirePermission('surgery.view'), async (c) => c.json(await listSurgeries(await dbOf(c), listQuery.parse(c.req.query()))))
  // #87
  .post('/', requirePermission('surgery.create'), async (c) => {
    const surgery = await planSurgery(await dbOf(c), newSurgery.parse(await bodyOf(c)), userOf(c).sub);
    auditDetails(c, { patientId: surgery.patientId, recordType: 'surgery', recordId: surgery.id });
    return c.json(surgery, 201);
  })
  // #88: a clinical read, so the inactive-patient rule applies. Venue payments join at #92.
  .get('/:id', requirePermission('surgery.view'), async (c) => {
    const db = await dbOf(c);
    const surgery = await getSurgery(db, c.req.param('id'));
    auditDetails(c, { patientId: surgery.patientId, recordType: 'surgery', recordId: surgery.id });
    await assertPatientAccess(db, userOf(c), await getPatient(db, surgery.patientId));
    return c.json({ ...surgery, implants: await surgeryImplants(db, surgery.id) });
  })
  // #89
  .patch('/:id', requirePermission('surgery.update'), async (c) => {
    const surgery = await updateSurgery(await dbOf(c), c.req.param('id'), surgeryChange.parse(await bodyOf(c)), userOf(c).sub);
    auditDetails(c, { patientId: surgery.patientId, recordType: 'surgery', recordId: surgery.id });
    return c.json(surgery);
  })
  // #90
  .post('/:id/checklist', requirePermission('surgery.update'), async (c) => {
    const surgery = await recordChecklist(await dbOf(c), c.req.param('id'), checklist.parse(await bodyOf(c)), userOf(c).sub);
    auditDetails(c, { patientId: surgery.patientId, recordType: 'surgery', recordId: surgery.id });
    return c.json(surgery);
  })
  // #85
  .post('/:id/implants', requirePermission('dept.ortho'), async (c) => {
    const implant = await addImplant(await dbOf(c), c.req.param('id'), newImplant.parse(await bodyOf(c)), userOf(c).sub);
    auditDetails(c, { patientId: implant.patientId, recordType: 'implant', recordId: implant.id });
    return c.json(implant, 201);
  });
