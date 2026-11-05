import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { pageQuery, pageRows } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { indiaDate } from '../../time/india.js';
import { PATIENT_SELECT, toPatient } from '../patients/patients.js';
import { UUID } from '../users/users.js';
import { assertAgentPatient, LIVE_LINK, notLinked } from './agent-access.js';
import { addPolicy, POLICY_COLUMNS, toPolicy, updatePolicy, type Policy } from './policies.js';
import { policyChange, policyFields } from './policies.routes.js';

// /other/insurance (api-list.md 8.x, #260-#263): an insurance agent's own linked patients and their policies.
// No catalog permissions: the group check is in app.ts and each patient is scoped by its agent link
// (agent-access.ts). An unlinked, unknown or malformed patient or policy is the same 403 forbidden.

/** A Policy without the staff fields: who saved it and the void fields. version stays (PATCH needs it). */
export type AgentPolicy = Omit<Policy, 'createdBy' | 'updatedBy' | 'voidedAt' | 'voidedBy' | 'voidReason'>;

const STAFF_FIELDS = ['createdBy', 'updatedBy', 'voidedAt', 'voidedBy', 'voidReason'] as const;

export function toAgentPolicy(p: Policy): AgentPolicy {
  const out: Record<string, unknown> = { ...p };
  for (const key of STAFF_FIELDS) delete out[key];
  return out as AgentPolicy;
}

// #711: when this agent's live link(s) to the patient end (to_date), or null for an open-ended link. Only the
// caller's own links count, and only live ones (the WHERE has LIVE_LINK too).
const LINK_ENDS_ON = `(SELECT CASE WHEN COUNT(l.to_date) = COUNT(*) THEN MAX(l.to_date)::text END
  FROM agent_links l JOIN users u ON u.id = l.agent_user_id
  WHERE l.patient_id = patients.id AND u.cognito_sub = $1 AND l.voided_at IS NULL
    AND l.from_date <= $2 AND (l.to_date IS NULL OR l.to_date >= $2)) AS link_ends_on`;
const AGENT_PATIENT_SELECT = PATIENT_SELECT.replace(' FROM patients', `, ${LINK_ENDS_ON} FROM patients`);

const listQuery = pageQuery.extend({ q: z.string().trim().min(1).max(100).optional() });
const newPolicy = z.object(policyFields).strict();

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** A live (not voided) policy's patient, or the generic 403 for a missing, voided or malformed one. */
async function policyPatient(db: Queryable, id: string): Promise<string> {
  const { rows } = UUID.test(id) ? await db.query('SELECT patient_id FROM policies WHERE id = $1 AND voided_at IS NULL', [id]) : { rows: [] };
  if (!rows[0]) throw notLinked();
  return String(rows[0].patient_id);
}

// Mounted at /other/insurance.
export const agentRoutes = new Hono<AuthEnv>()
  // #393 (api-list #260): the agent's live-linked patients by name; q matches name or UHID.
  .get('/patients', async (c) => {
    const query = listQuery.parse(c.req.query());
    const now = new Date();
    const where = [LIVE_LINK('$1', '$2')];
    const params: unknown[] = [userOf(c).sub, indiaDate(now)];
    if (query.q) {
      where.push('(patients.name_search LIKE $3 OR lower(patients.uhid) LIKE $3)');
      params.push(`%${query.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
    }
    const page = await pageRows(await dbOf(c), { select: AGENT_PATIENT_SELECT, where, params, orderBy: ['patients.name', 'patients.id'], direction: 'asc' }, query, (r) => {
      const p = toPatient(r, now);
      return { patientId: p.id, uhid: p.uhid, name: p.name, sex: p.sex, ...(p.ageYears !== undefined && { ageYears: p.ageYears }), linkEndsOn: r.link_ends_on == null ? null : String(r.link_ends_on) };
    });
    return c.json(page);
  })
  // #394 (api-list #261): all the patient's non-voided policies, in force or not, newest first.
  .get('/patients/:id/policies', async (c) => {
    const id = c.req.param('id');
    await assertAgentPatient(c, id);
    const { rows } = await (await dbOf(c)).query(
      `SELECT ${POLICY_COLUMNS} FROM policies WHERE patient_id = $1 AND voided_at IS NULL ORDER BY created_at DESC, id DESC`,
      [id],
    );
    return c.json(rows.map((r) => toAgentPolicy(toPolicy(r))));
  })
  // #395 (api-list #262): same body and checks as #132.
  .post('/patients/:id/policies', async (c) => {
    const id = c.req.param('id');
    await assertAgentPatient(c, id);
    const input = newPolicy.parse(await bodyOf(c));
    const policy = await addPolicy(await dbOf(c), id, input, userOf(c).sub);
    auditDetails(c, { patientId: policy.patientId, recordType: 'policy', recordId: policy.id });
    return c.json(toAgentPolicy(policy), 201);
  })
  // #396 (api-list #263): same body and checks as #133; a missing, voided or unlinked policy is the generic 403.
  .patch('/policies/:id', async (c) => {
    const id = c.req.param('id');
    const db = await dbOf(c);
    await assertAgentPatient(c, await policyPatient(db, id));
    const change = policyChange.parse(await bodyOf(c));
    const policy = await updatePolicy(db, id, change, userOf(c).sub);
    auditDetails(c, { patientId: policy.patientId, recordType: 'policy', recordId: policy.id, ...(change.reason && { reason: change.reason }) });
    return c.json(toAgentPolicy(policy));
  });
