import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import { getPatient, type BaseFields } from '../patients/patients.js';
import { UUID } from '../users/users.js';

// Insurance agents see only the patients linked to them, and only the insurance section (api-list.md AgentLink).

export interface AgentLink extends Omit<BaseFields, 'status'> {
  status: 'active' | 'ended';
  patientId: string;
  agentUserId: string;
  /** YYYY-MM-DD. */
  from: string;
  /** YYYY-MM-DD, the last day; none: until ended. */
  to?: string;
}

const COLUMNS = 'agent_links.*, from_date::text AS from_text, to_date::text AS to_text';

export function toAgentLink(r: Record<string, unknown>): AgentLink {
  return {
    ...baseFields(r as unknown as BaseRow),
    status: r.status as AgentLink['status'],
    patientId: String(r.patient_id),
    agentUserId: String(r.agent_user_id),
    from: String(r.from_text ?? r.from_date),
    ...(r.to_date != null && { to: String(r.to_text ?? r.to_date) }),
  };
}

/** 404 for no link (or not a UUID). */
export async function getAgentLink(db: Queryable, id: string): Promise<AgentLink> {
  const { rows } = UUID.test(id) ? await db.query(`SELECT ${COLUMNS} FROM agent_links WHERE id = $1`, [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such agent link');
  return toAgentLink(rows[0] as Record<string, unknown>);
}

/**
 * #139: links an active insurance agent to the patient from today. 404 for no patient; 422 for a user who isn't an
 * active insurance agent or a `to` before today; 409 duplicate if the agent already has an open link to the patient.
 */
export async function linkAgent(db: Queryable, patientId: string, input: { agentUserId: string; to?: string }, by: string, now = new Date()): Promise<AgentLink> {
  const patient = await getPatient(db, patientId);
  const { rows: agents } = await db.query("SELECT 1 FROM users WHERE id = $1 AND type = 'insurance' AND active", [input.agentUserId]);
  if (!agents[0]) throw new AppError(422, 'validation_failed', 'agentUserId: not an active insurance agent');
  const today = indiaDate(now);
  if (input.to && input.to < today) throw new AppError(422, 'validation_failed', 'to: before today');
  const { rows: open } = await db.query(
    "SELECT id FROM agent_links WHERE agent_user_id = $1 AND patient_id = $2 AND status = 'active' AND (to_date IS NULL OR to_date >= $3)",
    [input.agentUserId, patient.id, today],
  );
  if (open[0]) throw new AppError(409, 'duplicate', 'this agent is already linked to the patient', { agentLinkId: String(open[0].id) });
  const id = randomUUID();
  await db.query(
    `INSERT INTO agent_links (id, status, created_by, updated_by, patient_id, agent_user_id, from_date, to_date) VALUES ($1, 'active', $2, $2, $3, $4, $5, $6)`,
    [id, by, patient.id, input.agentUserId, today, input.to ?? null],
  );
  return getAgentLink(db, id);
}

/** #140: ends the link today, with a reason; the agent loses access from tomorrow. 409 ended if already ended. */
export async function endAgentLink(db: Queryable, id: string, reason: string, by: string, now = new Date()): Promise<AgentLink> {
  const link = await getAgentLink(db, id);
  if (link.status === 'ended') throw new AppError(409, 'ended', 'this link has already ended');
  const today = indiaDate(now);
  const to = link.to && link.to < today ? link.to : today;
  await updateRecord(db, 'agent_links', { id, version: link.version, by, reason, set: { status: 'ended', to_date: to } });
  return getAgentLink(db, id);
}
