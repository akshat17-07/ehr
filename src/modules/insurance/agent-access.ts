import type { Context } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';

// Who an insurance agent may see (api-list.md AgentLink). Every /other/insurance/* route about a patient checks here.
// The agent (users.id, found from the sign-in's Cognito sub) needs a live link to the patient: not voided, started
// (from_date <= India today) and not over (to_date empty or >= India today); the patient must exist, not be voided
// and not be merged away. Anything else is one plain 403 forbidden that never says whether the patient exists;
// the audit middleware logs it as denied.

export const notLinked = () => new AppError(403, 'forbidden', 'not a patient linked to this agent');

/**
 * SQL for "the agent with Cognito sub $sub has a live link to patients.id on India day $today", for a WHERE clause.
 * The caller's query must have `patients` in scope.
 */
export const LIVE_LINK = (sub: string, today: string) =>
  `EXISTS (SELECT 1 FROM agent_links l JOIN users u ON u.id = l.agent_user_id
     WHERE l.patient_id = patients.id AND u.cognito_sub = ${sub} AND l.voided_at IS NULL
       AND l.from_date <= ${today} AND (l.to_date IS NULL OR l.to_date >= ${today}))
   AND patients.voided_at IS NULL AND patients.merged_into IS NULL`;

/** 403 forbidden unless the signed-in agent has a live link to `patientId` (see above). Sets the audit row's patient. */
export async function assertAgentPatient(c: Context<AuthEnv>, patientId: string, now = new Date()): Promise<void> {
  if (!z.uuid().safeParse(patientId).success) throw notLinked();
  const db = await dbOf(c);
  const { rows } = await db.query(`SELECT 1 FROM patients WHERE patients.id = $1 AND ${LIVE_LINK('$2', '$3')} LIMIT 1`, [
    patientId,
    userOf(c).sub,
    indiaDate(now),
  ]);
  if (!rows[0]) throw notLinked();
  auditDetails(c, { patientId });
}
