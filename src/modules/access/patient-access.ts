import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import type { Patient } from '../patients/patients.js';

// The inactive-patient rule (api-list.md §3): a patient with no activity for INACTIVE_AFTER_DAYS is opened only with
// an approved access request (#29, #175) or break-glass (#30). It guards the clinical record (timeline, notes,
// prescriptions, documents ...), not the patient's details, so the front desk can still register a returning patient.
// Every per-patient clinical read calls assertPatientAccess.
// Until the inactive-access settings exist (#185, #186), the approvers (Head Doctor, Admin) open any record and
// everyone else follows the rule. Sensitive labels join this check with #187.

export const INACTIVE_EXEMPT_TYPES = ['admin', 'head_doctor'];

export interface Caller {
  sub: string;
  groups: readonly string[];
}

/** 403 inactive_patient unless the caller may open this patient's clinical record now. */
export async function assertPatientAccess(db: Queryable, caller: Caller, patient: Patient, now = new Date()): Promise<void> {
  if (!patient.inactive || caller.groups.some((g) => INACTIVE_EXEMPT_TYPES.includes(g))) return;
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
