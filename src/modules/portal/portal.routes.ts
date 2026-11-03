import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { pageQuery } from '../../db/page.js';
import { requireEnv } from '../../config/env.js';
import { dbOf, signerOf, userOf } from '../../middleware/context.js';
import { AppError } from '../../middleware/errors.js';
import { DOCUMENT_TYPES, documentViewUrl } from '../documents/documents.js';
import { address, mobile } from '../patients/patients.routes.js';
import { PRINT_LANGUAGES } from '../billing/print.js';
import { portalProfiles, resolvePortalPatient } from './portal-access.js';
import {
  hasSensitiveLabel,
  PORTAL_BILL_STATUSES,
  portalBillDetail,
  portalBillHtml,
  portalBillPatient,
  portalBills,
  portalDocumentPatient,
  portalDocuments,
  portalHome,
  portalPrescriptions,
  portalSurgeries,
  portalVisitDetail,
  portalVisits,
  updatePortalProfile,
} from './portal.js';

// /patient (api-list.md §8): own record or a linked family member only, resolved by resolvePortalPatient.
// No permission keys: the patient pool (requireUser('patient') in app.ts) is the gate.

const patientQuery = z.object({ patientId: z.string().max(100).optional() });
const patientPage = pageQuery.extend({ patientId: z.string().max(100).optional() });
const documentPage = patientPage.extend({ type: z.enum(DOCUMENT_TYPES).optional() });
const billPage = patientPage.extend({ status: z.enum(PORTAL_BILL_STATUSES).optional() });

// Contact details only: name, sex and DOB are corrected by the staff (#258). Same checks as the staff edit (#23).
const profileChange = z
  .object({
    version: z.number().int().min(1),
    mobile: mobile.nullable().optional(),
    email: z.email().max(254).nullable().optional(),
    address: address.nullable().optional(),
  })
  .strict();

const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

const notYours = () => new AppError(403, 'forbidden', 'not a patient this account may see');

/** A bill the portal may show, of a patient this account may act for; else the generic 403. Returns its id. */
async function resolvePortalBill(c: Context<AuthEnv>): Promise<string> {
  const id = c.req.param('id') ?? '';
  const patientId = z.uuid().safeParse(id).success ? await portalBillPatient(await dbOf(c), id) : undefined;
  if (!patientId) throw notYours();
  await resolvePortalPatient(c, patientId);
  return id;
}

export const portalRoutes = new Hono<AuthEnv>()
  // #239
  .get('/profiles', async (c) => {
    const profiles = await portalProfiles(await dbOf(c), userOf(c).sub);
    auditDetails(c, { patientId: profiles[0]?.patientId });
    return c.json(profiles);
  })
  // #240
  .patch('/profile', async (c) => {
    const { patientId } = patientQuery.parse(c.req.query());
    const profile = await resolvePortalPatient(c, patientId);
    const change = profileChange.parse(await bodyOf(c));
    const patient = await updatePortalProfile(await dbOf(c), profile.patientId, change, userOf(c).sub);
    auditDetails(c, { patientId: patient.id, recordType: 'patient', recordId: patient.id, reason: 'patient portal' });
    return c.json(patient);
  })
  // #241
  .get('/home', async (c) => {
    const { patientId } = patientQuery.parse(c.req.query());
    const profile = await resolvePortalPatient(c, patientId);
    return c.json(await portalHome(await dbOf(c), profile.patientId));
  })
  // #242
  .get('/visits', async (c) => {
    const { patientId, ...page } = patientPage.parse(c.req.query());
    const profile = await resolvePortalPatient(c, patientId);
    return c.json(await portalVisits(await dbOf(c), profile.patientId, page));
  })
  // #243: a visit of another patient, or none, is the same generic 403 (no existence check for others).
  .get('/visits/:id', async (c) => {
    const db = await dbOf(c);
    const id = c.req.param('id');
    const { rows } = z.uuid().safeParse(id).success
      ? await db.query('SELECT patient_id FROM encounters WHERE id = $1 AND voided_at IS NULL', [id])
      : { rows: [] };
    if (!rows[0]) throw new AppError(403, 'forbidden', 'not a patient this account may see');
    await resolvePortalPatient(c, String(rows[0].patient_id));
    return c.json(await portalVisitDetail(db, id));
  })
  // #244
  .get('/prescriptions', async (c) => {
    const { patientId, ...page } = patientPage.parse(c.req.query());
    const profile = await resolvePortalPatient(c, patientId);
    const db = await dbOf(c);
    if (await hasSensitiveLabel(db, profile.patientId)) return c.json({ items: [] });
    return c.json(await portalPrescriptions(db, profile.patientId, page));
  })
  // #245
  .get('/documents', async (c) => {
    const { patientId, ...query } = documentPage.parse(c.req.query());
    const profile = await resolvePortalPatient(c, patientId);
    return c.json(await portalDocuments(await dbOf(c), profile.patientId, query));
  })
  // #246: another patient's, unknown, pending, misfiled, voided or hidden documents are all the same generic 403.
  // The same 10-minute signed link as the staff view (#97); audited as a view of the document.
  .get('/documents/:id/view-url', async (c) => {
    const db = await dbOf(c);
    const id = c.req.param('id');
    const patientId = z.uuid().safeParse(id).success ? await portalDocumentPatient(db, id) : undefined;
    if (!patientId) throw new AppError(403, 'forbidden', 'not a patient this account may see');
    await resolvePortalPatient(c, patientId);
    const { document, ...link } = await documentViewUrl(db, signerOf(c), requireEnv('FILES_BUCKET'), id);
    auditDetails(c, { patientId: document.patientId, recordType: 'document', recordId: document.id });
    return c.json(link);
  })
  // #247: issued bills only (final, part paid, paid); a draft or void status filter is a 422.
  .get('/bills', async (c) => {
    const { patientId, ...query } = billPage.parse(c.req.query());
    const profile = await resolvePortalPatient(c, patientId);
    return c.json(await portalBills(await dbOf(c), profile.patientId, query));
  })
  // #248: another patient's, unknown, draft or voided bills are all the same generic 403.
  .get('/bills/:id', async (c) => {
    const id = await resolvePortalBill(c);
    auditDetails(c, { recordType: 'bill', recordId: id });
    return c.json(await portalBillDetail(await dbOf(c), id));
  })
  // #249: the staff print (#125), audited as a print like it.
  .get('/bills/:id/print', async (c) => {
    const { lang } = z.object({ lang: z.enum(PRINT_LANGUAGES).default('en') }).parse(c.req.query());
    const id = await resolvePortalBill(c);
    auditDetails(c, { action: 'print', recordType: 'bill', recordId: id });
    return c.html(await portalBillHtml(await dbOf(c), id, lang));
  })
  // #250
  .get('/surgeries', async (c) => {
    const { patientId } = patientQuery.parse(c.req.query());
    const profile = await resolvePortalPatient(c, patientId);
    return c.json(await portalSurgeries(await dbOf(c), profile.patientId));
  });
