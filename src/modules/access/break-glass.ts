import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { createAlert } from '../alerts/alerts.js';
import { getPatient } from '../patients/patients.js';

// Break-glass (api-list.md BreakGlassEvent): in an emergency a doctor or nurse opens a record they would otherwise
// have to ask for (#30). It works at once for 1 hour, every Head Doctor and Admin is alerted, and each event is
// reviewed later (#183, #184).

export const BREAK_GLASS_HOURS = 1;

export interface BreakGlassEvent {
  id: string;
  patientId: string;
  userId: string;
  reason: string;
  at: string;
  validUntil: string;
  reviewedBy?: string;
  reviewNote?: string;
}

export function toBreakGlassEvent(r: Record<string, unknown>): BreakGlassEvent {
  return {
    id: String(r.id),
    patientId: String(r.patient_id),
    userId: String(r.user_id),
    reason: String(r.reason),
    at: (r.at as Date).toISOString(),
    validUntil: (r.valid_until as Date).toISOString(),
    ...(r.reviewed_by != null && { reviewedBy: String(r.reviewed_by) }),
    ...(r.review_note != null && { reviewNote: String(r.review_note) }),
  };
}

/** #30: opens the patient's record to `by` for an hour and alerts the Head Doctors and Admins (not the caller). */
export async function breakGlass(db: Queryable, patientId: string, reason: string, by: string, now = new Date()): Promise<BreakGlassEvent> {
  const patient = await getPatient(db, patientId, now);
  const validUntil = new Date(now.getTime() + BREAK_GLASS_HOURS * 3_600_000);
  const { rows } = await db.query(
    `INSERT INTO break_glass_events (id, status, created_by, updated_by, patient_id, user_id, reason, at, valid_until)
     VALUES ($1, 'active', $2, $2, $3, $2, $4, $5, $6) RETURNING *`,
    [randomUUID(), by, patient.id, reason, now, validUntil],
  );
  const event = toBreakGlassEvent(rows[0] as Record<string, unknown>);

  const caller = await db.query('SELECT name FROM users WHERE cognito_sub = $1', [by]);
  const who = caller.rows[0] ? String(caller.rows[0].name) : by;
  const approvers = await db.query(
    "SELECT cognito_sub FROM users WHERE active AND type IN ('head_doctor', 'admin') AND cognito_sub <> $1",
    [by],
  );
  // The alert names the UHID, not the patient: alerts show on screens other people may see.
  for (const r of approvers.rows) {
    await createAlert(db, {
      userId: String(r.cognito_sub),
      kind: 'breakglass',
      title: `Break-glass: ${patient.uhid}`,
      body: `${who} used emergency access to ${patient.uhid}: ${reason}`,
      link: `/patients/${patient.id}`,
      by,
    });
  }
  return event;
}
