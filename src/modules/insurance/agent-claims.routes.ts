import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { pageQuery, pageRows } from '../../db/page.js';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { indiaDate } from '../../time/india.js';
import { UUID } from '../users/users.js';
import { assertAgentPatient, LIVE_LINK, notLinked } from './agent-access.js';
import { addClaimEvent, eventsOf, getClaim, toClaim, type Claim, type ClaimEvent } from './claims.js';

// /other/insurance/claims (api-list.md 8.x, #264-#266): an insurance agent's view of its linked patients' claims.
// Drafts are the hospital's own work in progress: the agent never sees them. A draft, missing, malformed or
// unlinked claim is the same generic 403 as an unlinked patient (agent-access.ts).

/** A ClaimEvent without who typed it in (a staff id). */
export type AgentClaimEvent = Omit<ClaimEvent, 'by'>;
/** A Claim without the staff fields and with stripped events. version stays. */
export type AgentClaim = Omit<Claim, 'createdBy' | 'updatedBy' | 'voidedAt' | 'voidedBy' | 'voidReason' | 'events'> & { events: AgentClaimEvent[] };

const STAFF_FIELDS = ['createdBy', 'updatedBy', 'voidedAt', 'voidedBy', 'voidReason'] as const;

export function toAgentClaimEvent(e: ClaimEvent): AgentClaimEvent {
  const out: Partial<ClaimEvent> = { ...e };
  delete out.by;
  return out as AgentClaimEvent;
}

export function toAgentClaim(claim: Claim): AgentClaim {
  const out: Record<string, unknown> = { ...claim, events: claim.events.map(toAgentClaimEvent) };
  for (const key of STAFF_FIELDS) delete out[key];
  return out as AgentClaim;
}

/** Every status but draft. */
const AGENT_STATUSES = ['submitted', 'query', 'approved', 'rejected', 'settled'] as const;

const claimsQuery = pageQuery.extend({ status: z.enum(AGENT_STATUSES).optional() });

/** As the staff #137 body, without submitted (only the hospital submits). */
const newEvent = z
  .object({
    status: z.enum(['query', 'approved', 'rejected', 'settled']),
    note: z.string().trim().min(1).max(2000).optional(),
    amountPaise: z.number().int().min(0).max(100_000_000_000).optional(),
  })
  .strict()
  .refine((e) => (e.status !== 'approved' && e.status !== 'settled') || e.amountPaise !== undefined, {
    message: 'needed for approved and settled',
    path: ['amountPaise'],
  });

/** A JSON body, or undefined (then the schema answers 422). */
const bodyOf = (c: Context) => c.req.json().catch(() => undefined);

/** A non-draft claim's patient after checking the agent's live link; the generic 403 for anything else. */
async function agentClaimPatient(c: Context<AuthEnv>, db: Queryable, id: string): Promise<string> {
  const { rows } = UUID.test(id) ? await db.query("SELECT patient_id FROM claims WHERE id = $1 AND status <> 'draft'", [id]) : { rows: [] };
  if (!rows[0]) throw notLinked();
  const patientId = String(rows[0].patient_id);
  await assertAgentPatient(c, patientId);
  return patientId;
}

// Mounted at /other/insurance/claims.
export const agentClaimsRoutes = new Hono<AuthEnv>()
  // #397 (api-list #264): non-draft claims of live-linked patients, newest first, events oldest first.
  .get('/', async (c) => {
    const query = claimsQuery.parse(c.req.query());
    const db = await dbOf(c);
    const where = [LIVE_LINK('$1', '$2'), "claims.status <> 'draft'"];
    const params: unknown[] = [userOf(c).sub, indiaDate()];
    if (query.status) where.push(`claims.status = $${params.push(query.status)}`);
    const page = await pageRows(
      db,
      { select: 'SELECT claims.* FROM claims JOIN patients ON patients.id = claims.patient_id', where, params, orderBy: ['claims.created_at', 'claims.id'] },
      query,
      (r) => toClaim(r),
    );
    const events = await eventsOf(db, page.items.map((cl) => cl.id));
    return c.json({ ...page, items: page.items.map((cl) => toAgentClaim({ ...cl, events: events.get(cl.id) ?? [] })) });
  })
  // #398 (api-list #265)
  .get('/:id', async (c) => {
    const id = c.req.param('id');
    const db = await dbOf(c);
    const patientId = await agentClaimPatient(c, db, id);
    const claim = await getClaim(db, id);
    auditDetails(c, { patientId, recordType: 'claim', recordId: claim.id });
    return c.json(toAgentClaim(claim));
  })
  // #399 (api-list #266): access first (403), then the body (422), then the move (409 bad_move; 422 approved > claimed).
  .post('/:id/events', async (c) => {
    const id = c.req.param('id');
    const db = await dbOf(c);
    const patientId = await agentClaimPatient(c, db, id);
    const input = newEvent.parse(await bodyOf(c));
    const event = await addClaimEvent(db, id, input, userOf(c).sub);
    auditDetails(c, { patientId, recordType: 'claim', recordId: event.claimId });
    return c.json(toAgentClaimEvent(event), 201);
  });
