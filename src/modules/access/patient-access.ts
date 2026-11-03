import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import type { Patient } from '../patients/patients.js';
import { ruleFor } from './inactive-settings.js';

// The inactive-patient rule (api-list.md §3): a patient with no activity for the caller's number of days (their own
// setting, else their type's, else 10; inactive-settings.ts, #185, #186) is opened only with an approved access
// request (#29, #175) or break-glass (#30), unless the caller's mode is any_record. It guards the clinical record (timeline, notes,
// prescriptions, documents ...), not the patient's details, so the front desk can still register a returning patient.
// Every per-patient clinical read calls assertPatientAccess.
// The approvers (Head Doctor, Admin) open any record. Sensitive labels join this check with #187.

export const INACTIVE_EXEMPT_TYPES = ['admin', 'head_doctor'];

export interface Caller {
  sub: string;
  groups: readonly string[];
}

/** 403 inactive_patient unless the caller may open this patient's clinical record now. */
export async function assertPatientAccess(db: Queryable, caller: Caller, patient: Patient, now = new Date()): Promise<void> {
  // patient.inactive uses the shortest limit anyone has, so a patient who is not inactive there is open to everyone.
  if (!patient.inactive || caller.groups.some((g) => INACTIVE_EXEMPT_TYPES.includes(g))) return;
  const rule = await ruleFor(db, caller.sub, caller.groups);
  if (rule.mode === 'any_record') return;
  const last = patient.lastActivityAt ? new Date(patient.lastActivityAt).getTime() : undefined;
  if (last !== undefined && now.getTime() - last <= rule.days * 86_400_000) return;
  const { rows } = await db.query(
    `SELECT 1 FROM access_requests WHERE requested_by = $1 AND patient_id = $2 AND status = 'approved' AND valid_until > $3
     UNION ALL
     SELECT 1 FROM break_glass_events WHERE user_id = $1 AND patient_id::text = $2 AND valid_until > $3
     LIMIT 1`,
    [caller.sub, patient.id, now],
  );
  if (rows.length > 0) return;
  throw new AppError(403, 'inactive_patient', 'this patient has had no visit for a while: request access, or use break-glass in an emergency');
}
