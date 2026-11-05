import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addSupplier, changeSupplier, getSupplier, listSuppliers } from './suppliers.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
const listQuery = z.object({ q: text(100).optional(), active: flag.optional() });

const gstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'a 15-character GSTIN');
const phone = z.string().trim().regex(/^\+?[\d\s-]{7,20}$/, 'a phone number');
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
const fields = {
  gstin,
  drugLicenceNo: text(50),
  phone,
  email: z.email().max(200),
  address,
};

const newSupplier = z
  .object({
    name: text(200),
    gstin: fields.gstin.optional(),
    drugLicenceNo: fields.drugLicenceNo.optional(),
    phone: fields.phone.optional(),
    email: fields.email.optional(),
    address: fields.address.optional(),
  })
  .strict();

const supplierChange = z
  .object({
    version: z.number().int().min(1),
    name: text(200).optional(),
    gstin: fields.gstin.nullable().optional(),
    drugLicenceNo: fields.drugLicenceNo.nullable().optional(),
    phone: fields.phone.nullable().optional(),
    email: fields.email.nullable().optional(),
    address: fields.address.nullable().optional(),
    active: z.boolean().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

/** /admin/suppliers */
export const adminSuppliersRoutes = new Hono<AuthEnv>()
  // #292
  .get('/', requirePermission('inventory.manage'), async (c) => c.json(await listSuppliers(await dbOf(c), listQuery.parse(c.req.query()))))
  // #706
  .get('/:id', requirePermission('inventory.manage'), async (c) => c.json(await getSupplier(await dbOf(c), c.req.param('id'))))
  // #293
  .post('/', requirePermission('inventory.manage'), async (c) => {
    const input = newSupplier.parse(await c.req.json().catch(() => undefined));
    const supplier = await addSupplier(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'supplier', recordId: supplier.id });
    return c.json(supplier, 201);
  })
  // #294
  .patch('/:id', requirePermission('inventory.manage'), async (c) => {
    const input = supplierChange.parse(await c.req.json().catch(() => undefined));
    const { supplier, changes } = await changeSupplier(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { recordType: 'supplier', recordId: supplier.id, changes, ...(input.reason && { reason: input.reason }) });
    return c.json(supplier);
  });
