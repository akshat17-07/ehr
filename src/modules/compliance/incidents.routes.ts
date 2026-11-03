import { Hono } from 'hono';
import { z } from 'zod';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { addIncident, addIncidentEvent, INCIDENT_KINDS, INCIDENT_STATUSES, listIncidents } from './incidents.js';

// /admin/incidents: the security incident log (#222-#224).

const text = (max: number) => z.string().trim().min(1).max(max);
const listQuery = z.object({ status: z.enum(INCIDENT_STATUSES).optional() });
const newIncident = z
  .object({ title: text(200), detectedAt: z.iso.datetime({ offset: true }), kind: z.enum(INCIDENT_KINDS), description: text(5000) })
  .strict();
const newEvent = z.object({ text: text(2000), status: z.enum(INCIDENT_STATUSES).optional() }).strict();

export const adminIncidentsRoutes = new Hono<AuthEnv>()
  // #222
  .get('/', requirePermission('compliance.incident'), async (c) => {
    const { status } = listQuery.parse(c.req.query());
    return c.json(await listIncidents(await dbOf(c), status));
  })
  // #223
  .post('/', requirePermission('compliance.incident'), async (c) => {
    const body = newIncident.parse(await c.req.json().catch(() => undefined));
    const incident = await addIncident(await dbOf(c), body, userOf(c).sub);
    auditDetails(c, { recordType: 'incident', recordId: incident.id });
    return c.json(incident, 201);
  })
  // #224
  .post('/:id/events', requirePermission('compliance.incident'), async (c) => {
    const body = newEvent.parse(await c.req.json().catch(() => undefined));
    const incident = await addIncidentEvent(await dbOf(c), c.req.param('id'), body, userOf(c).sub);
    auditDetails(c, { recordType: 'incident', recordId: incident.id });
    return c.json(incident);
  });
