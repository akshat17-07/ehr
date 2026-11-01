import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { APPOINTMENT_STATUSES, bookAppointment, cancelAppointment, checkIn, listAppointments, updateAppointment } from './appointments.js';

// /staff/appointments (api-list.md 6.4).

const listQuery = z.object({
  date: z.iso.date(),
  doctorId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
});

const durationMin = z.number().int().min(5).max(240);
const note = z.string().trim().min(1).max(500);

const newAppointment = z
  .object({
    patientId: z.uuid(),
    doctorId: z.uuid(),
    departmentId: z.uuid(),
    at: z.iso.datetime({ offset: true }),
    durationMin: durationMin.optional(),
    note: note.optional(),
  })
  .strict();

const appointmentChange = z
  .object({
    version: z.number().int().min(1),
    doctorId: z.uuid().optional(),
    at: z.iso.datetime({ offset: true }).optional(),
    durationMin: durationMin.optional(),
    note: note.nullable().optional(),
  })
  .strict();

const reasonBody = z.object({ reason: z.string().trim().min(5).max(500) }).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

export const appointmentsRoutes = new Hono<AuthEnv>()
  // #31
  .get('/', requirePermission('appointment.view'), async (c) => c.json(await listAppointments(await dbOf(c), listQuery.parse(c.req.query()))))
  // #32
  .post('/', requirePermission('appointment.create'), async (c) => {
    const input = newAppointment.parse(await bodyOf(c));
    const appointment = await bookAppointment(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { patientId: appointment.patientId, recordType: 'appointment', recordId: appointment.id });
    return c.json(appointment, 201);
  })
  // #33
  .patch('/:id', requirePermission('appointment.update'), async (c) => {
    const change = appointmentChange.parse(await bodyOf(c));
    const appointment = await updateAppointment(await dbOf(c), c.req.param('id'), change, userOf(c).sub);
    auditDetails(c, { patientId: appointment.patientId, recordType: 'appointment', recordId: appointment.id });
    return c.json(appointment);
  })
  // #34
  .post('/:id/check-in', requirePermission('appointment.update'), async (c) => {
    const result = await checkIn(await dbOf(c), c.req.param('id'), userOf(c).sub);
    auditDetails(c, { patientId: result.encounter.patientId, recordType: 'encounter', recordId: result.encounter.id });
    return c.json(result);
  })
  // #35
  .post('/:id/cancel', requirePermission('appointment.update'), async (c) => {
    const { reason } = reasonBody.parse(await bodyOf(c));
    const appointment = await cancelAppointment(await dbOf(c), c.req.param('id'), reason, userOf(c).sub);
    auditDetails(c, { patientId: appointment.patientId, recordType: 'appointment', recordId: appointment.id, reason });
    return c.json(appointment);
  });
