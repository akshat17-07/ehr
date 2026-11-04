import { env } from '../config/env.js';
import type { JobDeps } from './alert-digest.js';
import { backupStatus } from './backup-status.js';
import { recordRun } from './job-runs.js';

const JOB = 'backup_check';

/** #504: daily check that last night's backups exist. A problem throws, so the Lambda error alarm emails it. */
export async function backupCheck({ db, now = new Date() }: JobDeps): Promise<void> {
  const startedAt = new Date();
  const status = await backupStatus(db, now);

  if (env.STAGE !== 'prod' && status.jobs.every((j) => j.lastSuccessAt === null)) {
    console.warn(JSON.stringify({ msg: 'job warning', job: JOB, warning: 'non-prod, no backups to check' }));
    await recordRun(db, { job: JOB, startedAt, ok: true, detail: { skipped: 'non-prod, no backups' } });
    return;
  }

  await recordRun(db, { job: JOB, startedAt, ok: status.ok, detail: { problems: status.problems, lastExportAt: status.lastExportAt } });
  console.log(JSON.stringify({ msg: 'job summary', job: JOB, ok: status.ok, problems: status.problems.length, lastExportAt: status.lastExportAt }));
  if (!status.ok) throw new Error(`Backup check failed: ${status.problems.join('; ')}`);
}
