import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addDepartment, changeDepartment } from './departments.js';
import { addDrug, changeDrug, DRUG_SCHEDULES } from './drugs.js';
import { changeHospital } from './hospital-edit.js';
import { addInsurer, addPartnerHospital, changePartnerHospital } from './payers.js';
import { addTariffList, TARIFF_SETTINGS } from './tariffs.js';

// Hospital setup for the Admin (api-list.md 7.2 "Hospital setup (edit)", #189-#200). Staff read the same data in
// reference.routes.ts. Each write is audited with the record it changed.

const text = (max: number) => z.string().trim().min(1).max(max);

const newDepartment = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'upper-case letters and digits, 2 to 10, starting with a letter'),
    nameEn: text(100),
    nameHi: text(100),
  })
  .strict();

const departmentChange = z
  .object({ version: z.number().int().min(1), nameEn: text(100).optional(), nameHi: text(100).optional(), active: z.boolean().optional(), reason: z.string().trim().min(3).max(500).optional() })
  .strict();

const tariffItem = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,29}$/, 'letters, digits, "-" and "_", up to 30'),
    nameEn: text(200),
    nameHi: text(200).optional(),
    departmentId: z.uuid().optional(),
    pricePaise: z.number().int().min(0).max(1_000_000_000),
    gstRate: z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)]),
    sacCode: z.string().trim().regex(/^\d{4,8}$/, '4 to 8 digits').optional(),
    setting: z.enum(TARIFF_SETTINGS),
  })
  .strict();
const newTariffList = z.object({ validFrom: z.iso.date(), items: z.array(tariffItem).min(1).max(1000) }).strict();

const newDrug = z
  .object({
    name: text(200),
    strength: text(60).optional(),
    form: text(40).optional(),
    schedule: z.enum(DRUG_SCHEDULES),
    hsn: z.string().trim().regex(/^\d{4,8}$/, '4 to 8 digits').optional(),
    gstRate: z.union([z.literal(0), z.literal(5), z.literal(12), z.literal(18), z.literal(28)]).optional(),
    mrpPaise: z.number().int().min(0).max(1_000_000_000).optional(),
    ceilingPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  })
  .strict();
const drugChange = z
  .object({ ...newDrug.partial().shape, version: z.number().int().min(1), active: z.boolean().optional(), reason: z.string().trim().min(3).max(500).optional() })
  .strict();

const newPartnerHospital = z.object({ name: text(200) }).strict();
const newInsurer = z.object({ name: text(200), code: text(50).optional() }).strict();

const partnerHospitalChange = z
  .object({ version: z.number().int().min(1), name: text(200).optional(), active: z.boolean().optional(), reason: z.string().trim().min(3).max(500).optional() })
  .strict();

const address = z
  .object({
    line1: text(200),
    line2: text(200).optional(),
    city: text(100),
    district: text(100),
    state: text(100),
    pincode: z.string().regex(/^\d{6}$/, '6 digits'),
  })
  .strict();
// A prefix is part of every bill number (<prefix>/<yy-yy>/<n>), so no "/" in it.
const prefix = z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,10}$/, 'letters, digits and "-", up to 10');
const hospitalChange = z
  .object({
    version: z.number().int().min(1),
    name: text(200).optional(),
    address: address.optional(),
    phone: z.string().trim().regex(/^[0-9+\-() ]{6,20}$/, 'a phone number').optional(),
    email: z.email().max(200).optional(),
    mpLicenceNo: text(50).optional(),
    licenceValidTill: z.iso.date().nullable().optional(),
    gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'a 15-character GSTIN').nullable().optional(),
    pcpndtRegNo: text(50).nullable().optional(),
    mtpRegNo: text(50).nullable().optional(),
    invoicePrefix: prefix.optional(),
    billOfSupplyPrefix: prefix.optional(),
    refundLimitPaise: z.number().int().min(0).max(100_000_000).nullable().optional(),
    discountLimitPaise: z.number().int().min(0).max(100_000_000).nullable().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

export const setupAdminRoutes = new Hono<AuthEnv>()
  // #191 (Admin only)
  .patch('/departments/:id', requirePermission('settings.manage'), async (c) => {
    const input = departmentChange.parse(await c.req.json().catch(() => undefined));
    const department = await changeDepartment(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { recordType: 'department', recordId: department.id, ...(input.reason && { reason: input.reason }) });
    return c.json(department);
  })
  // #193 (Admin only)
  .post('/drugs', requirePermission('settings.drugs'), async (c) => {
    const input = newDrug.parse(await c.req.json().catch(() => undefined));
    const drug = await addDrug(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'drug', recordId: drug.id });
    return c.json(drug, 201);
  })
  // #307 (Admin only)
  .post('/partner-hospitals', requirePermission('settings.manage'), async (c) => {
    const input = newPartnerHospital.parse(await c.req.json().catch(() => undefined));
    const hospital = await addPartnerHospital(await dbOf(c), input.name, userOf(c).sub);
    auditDetails(c, { recordType: 'partner_hospital', recordId: hospital.id });
    return c.json(hospital, 201);
  })
  // #309 (Admin only)
  .post('/insurers', requirePermission('settings.manage'), async (c) => {
    const input = newInsurer.parse(await c.req.json().catch(() => undefined));
    const insurer = await addInsurer(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'insurer', recordId: insurer.id });
    return c.json(insurer, 201);
  })
  // #308 (Admin only)
  .patch('/partner-hospitals/:id', requirePermission('settings.manage'), async (c) => {
    const input = partnerHospitalChange.parse(await c.req.json().catch(() => undefined));
    const hospital = await changePartnerHospital(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { recordType: 'partner_hospital', recordId: hospital.id, ...(input.reason && { reason: input.reason }) });
    return c.json(hospital);
  })
  // #194 (Admin only)
  .patch('/drugs/:id', requirePermission('settings.drugs'), async (c) => {
    const input = drugChange.parse(await c.req.json().catch(() => undefined));
    const drug = await changeDrug(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { recordType: 'drug', recordId: drug.id, ...(input.reason && { reason: input.reason }) });
    return c.json(drug);
  })
  // #192 (Admin only)
  .post('/tariffs', requirePermission('settings.tariffs'), async (c) => {
    const input = newTariffList.parse(await c.req.json().catch(() => undefined));
    const list = await addTariffList(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'tariff_list', recordId: String(list.version), reason: `${list.count} prices from ${input.validFrom}` });
    return c.json({ ...list, reminder: 'Tell the CMHO about the new rates and put the new rate board up.' }, 201);
  })
  // #189 (Admin only)
  .patch('/hospital', requirePermission('settings.manage'), async (c) => {
    const input = hospitalChange.parse(await c.req.json().catch(() => undefined));
    const { hospital, changes } = await changeHospital(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'hospital', recordId: hospital.id, changes, ...(input.reason && { reason: input.reason }) });
    return c.json(hospital);
  })
  // #190 (Admin only)
  .post('/departments', requirePermission('settings.manage'), async (c) => {
    const input = newDepartment.parse(await c.req.json().catch(() => undefined));
    const department = await addDepartment(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'department', recordId: department.id });
    return c.json(department, 201);
  });
