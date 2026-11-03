import type { Queryable } from '../../db/migrate.js';
import { AppError } from '../../middleware/errors.js';
import type { Permission } from '../../permissions/catalog.js';
import { loadPermissions } from '../../permissions/check.js';
import type { Patient, SensitiveLabel } from '../patients/patients.js';
import { ruleFor } from './inactive-settings.js';

// Patient rules for clinical reads (api-list.md §3), after the endpoint's own permission and in this order:
// 1. Sensitive labels (#187): every label on the patient needs its permission (LABEL_PERMISSIONS), from the caller's
//    type, bundles, custom allow, or a grant for all patients or for this patient. Admin and Head Doctor get these
//    only by grant, like everyone else. Break-glass (#30) opens a labelled record too.
// 2. The inactive-patient rule: a patient with no activity for the caller's number of days (their own setting, else
//    their type's, else 10; inactive-settings.ts, #185, #186) is opened only with an approved access request (#29,
//    #175) or break-glass, unless the caller's mode is any_record. The approvers (Head Doctor, Admin) are exempt.
// It guards the clinical record (timeline, notes, prescriptions, documents ...), not the patient's details, so the
// front desk can still register a returning patient. Every per-patient clinical read calls assertPatientAccess.

export const INACTIVE_EXEMPT_TYPES = ['admin', 'head_doctor'];

export interface Caller {
  sub: string;
  groups: readonly string[];
}

/** The permission each sensitive label needs to open the record. */
export const LABEL_PERMISSIONS: Record<SensitiveLabel, Permission> = {
  mtp: 'mtp.view',
  pcpndt: 'pcpndt.view',
  hiv: 'sensitive.view',
  mental_health: 'sensitive.view',
};

const hasBreakGlass = async (db: Queryable, sub: string, patientId: string, now: Date) =>
  (await db.query('SELECT 1 FROM break_glass_events WHERE user_id = $1 AND patient_id::text = $2 AND valid_until > $3 LIMIT 1', [sub, patientId, now])).rows.length > 0;

/** 403 sensitive_record unless the caller holds the permission of every label on the patient, or used break-glass. */
async function assertLabelAccess(db: Queryable, caller: Caller, patient: Patient, now: Date): Promise<void> {
  const perms = await loadPermissions(db, caller.sub, caller.groups, now);
  const allowed = new Set<Permission>(perms.effective);
  for (const g of perms.grants) if (g.scope === 'patient' && g.scopeId === patient.id) allowed.add(g.permission);
  for (const p of perms.custom.deny) allowed.delete(p);
  if (patient.labels.every((l) => allowed.has(LABEL_PERMISSIONS[l]))) return;
  if (await hasBreakGlass(db, caller.sub, patient.id, now)) return;
  throw new AppError(403, 'sensitive_record', 'this record has a sensitive label: you need access to it, or use break-glass in an emergency');
}

/** 403 sensitive_record or inactive_patient unless the caller may open this patient's clinical record now. */
export async function assertPatientAccess(db: Queryable, caller: Caller, patient: Patient, now = new Date()): Promise<void> {
  if (patient.labels.length > 0) await assertLabelAccess(db, caller, patient, now);
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
