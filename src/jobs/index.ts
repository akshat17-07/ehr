import { getDb } from '../db/client.js';
import type { JobDeps } from './alert-digest.js';
import { backupExport } from './backup-export.js';
import { auditExport } from './audit-export.js';
import { licenceCheck } from './licence-check.js';
import { stockScan } from './stock-scan.js';

// Scheduled jobs, run by the same Lambda as the API (EventBridge sends `{ job: "<name>" }`).
// Schedules: infra/constructs/jobs.ts. A job that isn't built yet fails loudly (its rule stays off until then).
export const JOB_NAMES = [
  'backup_export',
  'audit_export',
  'stock_scan',
  'licence_check',
  'backup_check',
  'pcpndt_monthly',
  'retention_review',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export interface JobEvent {
  job: JobName;
}

type Job = (deps: JobDeps) => Promise<void>;

const notBuilt =
  (name: JobName): Job =>
  async () => {
    throw new Error(`Job ${name} is not built yet`);
  };

const jobs: Record<JobName, Job> = {
  backup_export: (deps) => backupExport(deps),
  audit_export: auditExport,
  stock_scan: stockScan,
  licence_check: licenceCheck,
  backup_check: notBuilt('backup_check'),
  pcpndt_monthly: notBuilt('pcpndt_monthly'),
  retention_review: notBuilt('retention_review'),
};

export function isJobEvent(event: unknown): event is JobEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'job' in event &&
    JOB_NAMES.includes((event as { job: unknown }).job as JobName)
  );
}

export async function runJob(event: JobEvent, deps?: Partial<JobDeps>): Promise<{ job: JobName; ok: true }> {
  console.log(JSON.stringify({ msg: 'job start', job: event.job }));
  await jobs[event.job]({ db: deps?.db ?? (await getDb()), ...(deps?.now && { now: deps.now }), ...(deps?.backupFiles && { backupFiles: deps.backupFiles }) });
  console.log(JSON.stringify({ msg: 'job done', job: event.job }));
  return { job: event.job, ok: true };
}
