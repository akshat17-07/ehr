import type { Permission } from './catalog.js';

// Built-in permissions of each staff type: api-list.md §4, row by row (✓ = built in).
// They are copied into type_permissions when the database is made; Admin / Head Doctor can then change them
// (#309), and "reset" goes back to this list. Changing a list here does not change a database that already
// exists: add a migration for that.

/** Staff types: the Cognito groups of the staff pool (one per user). */
export const STAFF_TYPES = ['admin', 'head_doctor', 'doctor', 'nurse', 'staff', 'medical', 'insurance', 'gp'] as const;
export type StaffType = (typeof STAFF_TYPES)[number];

const A = 'admin', H = 'head_doctor', D = 'doctor', N = 'nurse', S = 'staff', M = 'medical';

const ROWS: [permissions: Permission[], types: StaffType[]][] = [
  [['patient.search', 'patient.view'], [A, H, D, N, S, M]],
  [['patient.register', 'patient.update'], [A, H, D]],
  [['appointment.view', 'appointment.create', 'appointment.update'], [A, H, D]],
  [
    [
      'encounter.view', 'encounter.create', 'encounter.update', 'note.write', 'note.sign', 'note.addend',
      'diagnosis.write', 'order.view', 'order.write', 'result.record', 'allergy.write', 'problem.write',
    ],
    [A, H, D],
  ],
  [['vitals.record', 'observation.record'], [A, H, D, N]],
  [['nursing_note.write', 'mar.record'], [A, H, D, N]],
  [['rx.write', 'rx.upload', 'rx.confirm_upload'], [A, H, D]],
  [['rx.view'], [A, H, D, N, M]],
  [['dept.dental', 'dept.ortho', 'dept.anc'], [A, H, D]], // doctors: own department (checked with the patient rules)
  [['admission.create', 'admission.update', 'discharge.write', 'discharge.sign'], [A, H, D]],
  [['surgery.view', 'surgery.create', 'surgery.update', 'surgery.op_note', 'surgery.venue_payment'], [A, H, D]],
  [['document.view', 'document.upload', 'document.misfile'], [A, H, D, N]],
  [
    [
      'bill.view', 'bill.create', 'bill.update', 'bill.finalise', 'bill.void', 'bill.discount',
      'payment.mark_paid', 'deposit.create', 'deposit.apply', 'refund.create',
    ],
    [A, H, D],
  ],
  [['dispense.view', 'dispense.create', 'pharmacy_bill.view', 'pharmacy_bill.create', 'pharmacy_refund.create', 'register.print'], [A, H, M]],
  [
    ['stock.view', 'stock.receive', 'inventory.add', 'stock.indent', 'stock.quarantine', 'stock.count', 'stock.issue', 'stock.supplier_return'],
    [A, H, M],
  ],
  [['inventory.manage', 'reorder.check', 'purchase.create'], [A, H]],
  [['insurance.policy', 'insurance.agent_link', 'claim.view', 'claim.create', 'claim.update'], [A, H, D]],
  [['records.release'], [A, H]],
  [['fhir.export'], [A, H, D]],
  [['vital_events.record'], [H, D, N]],
  [['referrer.view', 'referrer.create_pseudo', 'referral.record'], [A, H, D]],
  [['access.request'], [D, N, S, M]],
  [['breakglass.invoke'], [A, H, D, N]],
  [['report.clinical'], [A, H, D]], // doctors: own department
  [['report.finance'], [A, H]],
  [
    [
      'approval.view', 'approval.access', 'approval.refund', 'approval.discount', 'approval.payroll',
      'grant.view', 'grant.create', 'grant.revoke',
      'payroll.view', 'payroll.employee', 'payroll.run', 'payroll.bank_file',
      'referrer.attach_user', 'referrer.merge', 'referrer.detach', 'patient.merge', 'sensitive.label',
      'audit.read', 'audit.review',
      'compliance.rights', 'compliance.incident', 'compliance.legal_hold', 'compliance.registers',
    ],
    [A, H],
  ],
  [['user.view', 'user.permissions'], [A, H]],
  [
    [
      'user.create', 'user.update', 'user.deactivate', 'user.mfa_reset', 'role.promote_head_doctor', 'grant_rule.manage',
      'settings.view', 'settings.manage', 'settings.bundles', 'settings.drugs', 'settings.tariffs', 'fhir.export_all',
    ],
    [A],
  ],
];

/** Never built in for anyone, even an Admin: only with a time-limited grant (§4 "G"). */
export const GRANT_ONLY: Permission[] = ['pcpndt.view', 'pcpndt.write', 'mtp.view', 'mtp.write', 'sensitive.view'];

/** The built-in list of every staff type. Insurance agents and GPs use /other, scoped by their links, not by permissions. */
export const DEFAULT_TYPE_PERMISSIONS: Record<StaffType, Permission[]> = Object.fromEntries(
  STAFF_TYPES.map((type) => [type, ROWS.filter(([, types]) => types.includes(type)).flatMap(([permissions]) => permissions)]),
) as Record<StaffType, Permission[]>;
