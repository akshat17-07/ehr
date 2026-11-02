import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { pageQuery } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { getPatient } from '../patients/patients.js';
import { assertPatientAccess } from '../access/patient-access.js';
import { addDiscount, billDiscounts } from './discounts.js';
import { BILL_STATUSES, createBill, finaliseBill, getBill, listBills, updateBillLines } from './bills.js';

export const lineInput = z
  .object({
    tariffId: z.uuid().optional(),
    text: z.string().trim().min(1).max(200).optional(),
    qty: z.number().int().min(1).max(10_000),
    unitPaise: z.number().int().min(0).max(100_000_000).optional(),
  })
  .strict();

const newBill = z
  .object({ patientId: z.uuid(), encounterId: z.uuid().optional(), admissionId: z.uuid().optional(), lines: z.array(lineInput).max(200) })
  .strict();

const billsQuery = pageQuery
  .extend({
    patientId: z.uuid().optional(),
    date: z.iso.date().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    status: z.enum(BILL_STATUSES).optional(),
    number: z.string().trim().min(1).max(50).optional(),
  })
  .refine((q) => !q.date || (!q.from && !q.to), { message: 'date or from/to, not both', path: ['date'] });

const billUpdate = z.object({ version: z.number().int().min(1), lines: z.array(lineInput).max(200) }).strict();

const newDiscount = z.object({ amountPaise: z.number().int().min(1).max(100_000_000), reason: z.string().trim().min(3).max(500) }).strict();

const versionOnly = z.object({ version: z.number().int().min(1) }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** /staff/bills */
export const billsRoutes = new Hono<AuthEnv>()
  // #116
  .post('/', requirePermission('bill.create'), async (c) => {
    const input = newBill.parse(await bodyOf(c));
    const bill = await createBill(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: bill.patientId, recordType: 'bill', recordId: bill.id });
    return c.json(bill, 201);
  })
  // #117
  .get('/', requirePermission('bill.view'), async (c) => {
    const query = billsQuery.parse(c.req.query());
    return c.json(await listBills(await dbOf(c), query));
  })
  // #118
  .get('/:id', requirePermission('bill.view'), async (c) => {
    const db = await dbOf(c);
    const bill = await getBill(db, c.req.param('id'));
    auditDetails(c, { patientId: bill.patientId, recordType: 'bill', recordId: bill.id });
    await assertPatientAccess(db, userOf(c), await getPatient(db, bill.patientId));
    return c.json({ ...bill, discounts: await billDiscounts(db, bill.id) });
  })
  // #119
  .patch('/:id', requirePermission('bill.update'), async (c) => {
    const input = billUpdate.parse(await bodyOf(c));
    const bill = await updateBillLines(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: bill.patientId, recordType: 'bill', recordId: bill.id });
    return c.json(bill);
  })
  // #120
  .post('/:id/finalise', requirePermission('bill.finalise'), async (c) => {
    const input = versionOnly.parse(await bodyOf(c));
    const bill = await finaliseBill(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { patientId: bill.patientId, recordType: 'bill', recordId: bill.id });
    return c.json(bill);
  })
  // #121
  .post('/:id/discounts', requirePermission('bill.discount'), async (c) => {
    const input = newDiscount.parse(await bodyOf(c));
    const discount = await addDiscount(await dbOf(c), c.req.param('id'), input, userOf(c).sub);
    auditDetails(c, { recordType: 'discount', recordId: discount.id, reason: discount.reason });
    return c.json(discount, 201);
  });
