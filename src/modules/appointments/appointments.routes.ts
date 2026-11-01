import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { APPOINTMENT_STATUSES, listAppointments } from './appointments.js';

// /staff/appointments (api-list.md 6.4).

const listQuery = z.object({
  date: z.iso.date(),
  doctorId: z.uuid().optional(),
  departmentId: z.uuid().optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
});

export const appointmentsRoutes = new Hono<AuthEnv>()
  // #31
  .get('/', requirePermission('appointment.view'), async (c) => c.json(await listAppointments(await dbOf(c), listQuery.parse(c.req.query()))));
