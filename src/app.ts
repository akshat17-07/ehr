import { adminPatientMergesRoutes, patientMergesRoutes } from './modules/patients/merges.routes.js';
import { patientsRoutes } from './modules/patients/patients.routes.js';
import { referenceRoutes } from './modules/reference/reference.routes.js';
import { Hono } from 'hono';
import {
  GP_GROUPS,
  INSURANCE_GROUPS,
  MANAGEMENT_GROUPS,
  WORKFORCE_GROUPS,
  requireUser,
  type AuthEnv,
} from './middleware/auth.js';
import { getDb } from './db/client.js';
import type { Queryable } from './db/migrate.js';
import { signGetUrl, type SignGetUrl } from './files/signed-url.js';
import { s3Exports, type ExportFiles } from './files/exports.js';
import { s3Uploads, type FileUploads } from './files/uploads.js';
import { sesMailer, type Mailer } from './mail/mailer.js';
import { cognitoStaffAccounts, type StaffAccounts } from './identity/staff-accounts.js';
import { auditRequests } from './middleware/audit.js';
import { onError, onNotFound } from './middleware/errors.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { meRoutes } from './modules/me/me.routes.js';
import { myPermissionsRoutes } from './modules/me/permissions.routes.js';
import { myAlertsRoutes } from './modules/alerts/alerts.routes.js';
import { appointmentsRoutes } from './modules/appointments/appointments.routes.js';
import { encountersRoutes } from './modules/encounters/encounters.routes.js';
import { notesRoutes } from './modules/encounters/notes.routes.js';
import { diagnosesRoutes } from './modules/encounters/diagnoses.routes.js';
import { ordersRoutes } from './modules/encounters/orders.routes.js';
import { prescriptionsRoutes } from './modules/prescriptions/prescriptions.routes.js';
import { admissionsRoutes } from './modules/admissions/admissions.routes.js';
import { dischargeRoutes } from './modules/admissions/discharge.routes.js';
import { mtpRoutes } from './modules/departments/mtp.routes.js';
import { documentsRoutes } from './modules/documents/documents.routes.js';
import { pharmacyRoutes } from './modules/pharmacy/pharmacy.routes.js';
import { dispensesRoutes } from './modules/pharmacy/dispenses.routes.js';
import { stockRoutes } from './modules/inventory/stock.routes.js';
import { inventoryRoutes } from './modules/inventory/items.routes.js';
import { recallsRoutes } from './modules/inventory/recalls.routes.js';
import { depositsRoutes } from './modules/billing/deposits.routes.js';
import { reportsRoutes } from './modules/reports/reports.routes.js';
import { policiesRoutes } from './modules/insurance/policies.routes.js';
import { claimsRoutes } from './modules/insurance/claims.routes.js';
import { agentLinksRoutes } from './modules/insurance/agent-links.routes.js';
import { referralsRoutes, referrersRoutes } from './modules/referrals/referrals.routes.js';
import { exportsRoutes, fhirRoutes, recordRequestsRoutes } from './modules/records/record-requests.routes.js';
import { billsRoutes } from './modules/billing/bills.routes.js';
import { purchaseOrdersRoutes } from './modules/inventory/purchase-orders.routes.js';
import { registersRoutes } from './modules/pharmacy/registers.routes.js';
import { surgeriesRoutes } from './modules/surgeries/surgeries.routes.js';
import { allergiesRoutes } from './modules/patients/allergies.routes.js';
import { problemsRoutes } from './modules/patients/problems.routes.js';
import { adminBreakGlassRoutes } from './modules/access/break-glass.routes.js';
import { accessRequestsRoutes, adminAccessRequestsRoutes, myAccessRequestsRoutes } from './modules/access/access-requests.routes.js';
import { myPayslipsRoutes } from './modules/payroll/payslips.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import { permissionsAdminRoutes } from './modules/permissions/permissions.routes.js';
import { adminDiscountsRoutes, adminRefundsRoutes } from './modules/billing/decisions.routes.js';
import { approvalsRoutes } from './modules/approvals/approvals.routes.js';
import { setupAdminRoutes } from './modules/reference/setup.routes.js';

// Route prefixes match API Gateway (infra/constructs/api.ts). Full endpoint list: docs/india/api-list.md
//   /health             public
//   /staff/*            staff pool; admin, head_doctor, doctor, nurse, staff, medical (shared, per-endpoint permission)
//   /admin/*            staff pool; admin, head_doctor (per-endpoint permission; some are admin only)
//   /patient/*          patient pool; own (and linked family) records only
//   /other/insurance/*  staff pool; insurance agents, linked patients only
//   /other/gp/*         staff pool; referring GPs, own referrals only
export interface AppDeps {
  /** The database (tests pass an in-memory one). */
  db?: () => Promise<Queryable>;
  /** Signed S3 links (tests pass a fake). */
  signUrl?: SignGetUrl;
  /** Upload links and stored-file checks (tests pass a fake). */
  uploads?: FileUploads;
  /** Cognito staff accounts (tests pass a fake). */
  staffAccounts?: StaffAccounts;
  /** The exports bucket (tests pass a fake). */
  exportFiles?: ExportFiles;
  /** Email (tests pass a fake). */
  mailer?: Mailer;
}

export function createApp({
  db = getDb,
  signUrl = signGetUrl,
  uploads = s3Uploads,
  staffAccounts = cognitoStaffAccounts,
  exportFiles = s3Exports,
  mailer = sesMailer,
}: AppDeps = {}) {
  const staff = new Hono<AuthEnv>()
    .use(requireUser('staff', WORKFORCE_GROUPS))
    .route('/me', meRoutes)
    .route('/me/permissions', myPermissionsRoutes)
    .route('/me/alerts', myAlertsRoutes)
    .route('/me/access-requests', myAccessRequestsRoutes)
    .route('/me/payslips', myPayslipsRoutes)
    .route('/patients', patientsRoutes)
    .route('/patient-merges', patientMergesRoutes)
    .route('/access-requests', accessRequestsRoutes)
    .route('/appointments', appointmentsRoutes)
    .route('/encounters', encountersRoutes)
    .route('/notes', notesRoutes)
    .route('/diagnoses', diagnosesRoutes)
    .route('/orders', ordersRoutes)
    .route('/prescriptions', prescriptionsRoutes)
    .route('/admissions', admissionsRoutes)
    .route('/discharge-summaries', dischargeRoutes)
    .route('/mtp-register', mtpRoutes)
    .route('/surgeries', surgeriesRoutes)
    .route('/documents', documentsRoutes)
    .route('/pharmacy', pharmacyRoutes)
    .route('/dispenses', dispensesRoutes)
    .route('/stock', stockRoutes)
    .route('/inventory', inventoryRoutes)
    .route('/recalls', recallsRoutes)
    .route('/bills', billsRoutes)
    .route('/deposits', depositsRoutes)
    .route('/reports', reportsRoutes)
    .route('/policies', policiesRoutes)
    .route('/claims', claimsRoutes)
    .route('/agent-links', agentLinksRoutes)
    .route('/referrers', referrersRoutes)
    .route('/referrals', referralsRoutes)
    .route('/record-requests', recordRequestsRoutes)
    .route('/fhir', fhirRoutes)
    .route('/exports', exportsRoutes)
    .route('/purchase-orders', purchaseOrdersRoutes)
    .route('/registers', registersRoutes)
    .route('/allergies', allergiesRoutes)
    .route('/problems', problemsRoutes)
    .route('/', referenceRoutes);
  const admin = new Hono<AuthEnv>()
    .use(requireUser('staff', MANAGEMENT_GROUPS))
    .route('/me', meRoutes)
    .route('/users', usersRoutes)
    .route('/approvals', approvalsRoutes)
    .route('/', setupAdminRoutes)
    .route('/access-requests', adminAccessRequestsRoutes)
    .route('/refunds', adminRefundsRoutes)
    .route('/discounts', adminDiscountsRoutes)
    .route('/patient-merges', adminPatientMergesRoutes)
    .route('/break-glass-events', adminBreakGlassRoutes)
    .route('/', permissionsAdminRoutes);
  const patient = new Hono<AuthEnv>().use(requireUser('patient')).route('/me', meRoutes);
  const insurance = new Hono<AuthEnv>().use(requireUser('staff', INSURANCE_GROUPS)).route('/me', meRoutes);
  const gp = new Hono<AuthEnv>().use(requireUser('staff', GP_GROUPS)).route('/me', meRoutes);

  // Every request except /health gets an audit row (middleware/audit.ts).
  const audited = new Hono<AuthEnv>()
    .use(async (c, next) => {
      c.set('db', db);
      c.set('signGetUrl', signUrl);
      c.set('uploads', uploads);
      c.set('staffAccounts', staffAccounts);
      c.set('exportFiles', exportFiles);
      c.set('mailer', mailer);
      await next();
    })
    .use(auditRequests(db))
    .route('/staff', staff)
    .route('/admin', admin)
    .route('/patient', patient)
    .route('/other/insurance', insurance)
    .route('/other/gp', gp)
    .onError(onError)
    .notFound(onNotFound);

  return new Hono<AuthEnv>()
    .route('/health', healthRoutes)
    .route('/', audited)
    .onError(onError)
    .notFound(onNotFound);
}
