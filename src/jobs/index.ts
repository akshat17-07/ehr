import { getDb } from '../db/client.js';
import type { JobDeps } from './alert-digest.js';
import { backupCheck } from './backup-check.js';
import { backupExport } from './backup-export.js';
import { auditExport } from './audit-export.js';
import { fullExportJob } from '../modules/records/full-export.js';
import { licenceCheck } from './licence-check.js';
import { pcpndtMonthlyJob } from './pcpndt-monthly.js';
import { retentionReview } from './retention-review.js';
import { stockScan } from './stock-scan.js';

// Scheduled jobs, run by the jobs Lambda (same code as the API, 15 minutes) (EventBridge sends `{ job: "<name>" }`).
// Schedules: infra/constructs/jobs.ts. A job that isn't built yet fails loudly (its rule stays off until then).
export const JOB_NAMES = [
  'backup_export',
  'audit_export',
  'stock_scan',
  'licence_check',
  'backup_check',
  'pcpndt_monthly',
  'retention_review',
  // On demand (started by POST /admin/fhir/$export), so it has no schedule.
  'fhir_export',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export interface JobEvent {
  job: JobName;
  /** fhir_export: the exports row to fill. */
  exportId?: string;
  /** fhir_export: only patients changed since this ISO time. */
  since?: string;
}

type Job = (deps: JobDeps) => Promise<void>;

const jobs: Record<JobName, Job> = {
  backup_export: (deps) => backupExport(deps),
  audit_export: auditExport,
  stock_scan: stockScan,
  licence_check: licenceCheck,
  backup_check: backupCheck,
  pcpndt_monthly: pcpndtMonthlyJob,
  retention_review: retentionReview,
  fhir_export: fullExportJob,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isJobEvent(event: unknown): event is JobEvent {
  if (typeof event !== 'object' || event === null || !('job' in event)) return false;
  const { job, exportId, since } = event as { job: unknown; exportId?: unknown; since?: unknown };
  if (!JOB_NAMES.includes(job as JobName)) return false;
  if (exportId !== undefined && !(typeof exportId === 'string' && UUID.test(exportId))) return false;
  if (since !== undefined && !(typeof since === 'string' && !Number.isNaN(Date.parse(since)))) return false;
  return true;
}

export async function runJob(event: JobEvent, deps?: Partial<JobDeps>): Promise<{ job: JobName; ok: true }> {
  console.log(JSON.stringify({ msg: 'job start', job: event.job }));
  await jobs[event.job]({
    db: deps?.db ?? (await getDb()),
    ...(deps?.now && { now: deps.now }),
    ...(deps?.backupFiles && { backupFiles: deps.backupFiles }),
    ...(deps?.exportFiles && { exportFiles: deps.exportFiles }),
    ...(event.exportId && { exportId: event.exportId }),
    ...(event.since && { since: event.since }),
  });
  console.log(JSON.stringify({ msg: 'job done', job: event.job }));
  return { job: event.job, ok: true };
}
