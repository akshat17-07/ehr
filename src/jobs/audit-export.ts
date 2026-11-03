import { gzipSync } from 'node:zlib';
import { verifyAuditChain } from '../audit/log.js';
import { s3Backup } from '../backup/files.js';
import { AGE_RECIPIENT, encryptForBackup } from '../backup/encrypt.js';
import { env } from '../config/env.js';
import { usersWithPermission } from '../permissions/check.js';
import { indiaDate } from '../time/india.js';
import { recordRun as record, type RunRow } from './job-runs.js';
import { raiseIfChanged, type JobDeps, type Tally } from './alert-digest.js';

const JOB = 'audit_export';
const PAGE = 1000;
const recordRun = (db: Parameters<typeof record>[0], run: Omit<RunRow, 'job'>) => record(db, { job: JOB, ...run });

/** #501: nightly check of the audit hash chain, then an encrypted copy of the new audit rows in the backup bucket. */
export async function auditExport({ db, now = new Date(), backupFiles }: JobDeps): Promise<void> {
  const startedAt = new Date();
  const tally: Tally = { alertsCreated: 0, skippedUnchanged: 0 };

  // (a) The chain. A break raises an alert but never stops the export: the export is the evidence.
  const chain = await verifyAuditChain(db);
  if (!chain.ok) {
    const body = `Audit chain broken at entry ${chain.brokenAt}: ${chain.problem}`;
    for (const userId of await usersWithPermission(db, 'audit.review', now)) {
      await raiseIfChanged(db, userId, { kind: 'audit', title: 'Audit log check failed', body, link: '/admin/audit' }, JOB, tally);
    }
  }
  const chainFailure = chain.ok ? undefined : new Error(`Audit chain broken at entry ${chain.brokenAt}: ${chain.problem}`);
  const finish = async (run: Omit<RunRow, 'job' | 'startedAt' | 'ok'> & { ok?: boolean }) => {
    await recordRun(db, { startedAt, ok: chain.ok, ...run });
    if (chainFailure) throw chainFailure;
  };

  const recipient = env.BACKUP_AGE_RECIPIENT;
  const files = backupFiles ?? (env.BACKUP_BUCKET ? s3Backup : undefined);
  if (!recipient || !files) {
    if (env.STAGE === 'prod') {
      await recordRun(db, { startedAt, ok: false, detail: { error: 'no backup config' } });
      throw new Error('Backup bucket or age recipient is not configured');
    }
    console.warn(JSON.stringify({ msg: 'job warning', job: JOB, warning: 'no backup config, audit rows not exported' }));
    console.log(JSON.stringify({ msg: 'job summary', job: JOB, checked: chain.checked, exported: 0, alertsCreated: tally.alertsCreated }));
    return finish({ detail: { skipped: 'no backup config' } });
  }
  if (!AGE_RECIPIENT.test(recipient)) {
    await recordRun(db, { startedAt, ok: false, detail: { error: 'bad recipient' } });
    throw new Error('BACKUP_AGE_RECIPIENT is not a valid age recipient');
  }

  // (b) Rows since the last successful upload, up to the newest row as of now.
  const last = await db.query("SELECT max(last_seq)::text AS seq FROM job_runs WHERE job = $1 AND s3_key IS NOT NULL", [JOB]);
  const fromSeq = last.rows[0]?.seq ? Number(last.rows[0].seq) + 1 : 1;
  const top = await db.query('SELECT max(seq)::text AS seq FROM audit_events');
  const toSeq = top.rows[0]?.seq ? Number(top.rows[0].seq) : 0;

  const summary = (exported: number, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ msg: 'job summary', job: JOB, checked: chain.checked, exported, fromSeq, toSeq, alertsCreated: tally.alertsCreated, ...extra }));

  if (toSeq < fromSeq) {
    summary(0);
    return finish({ detail: { exported: 0 } });
  }

  let key = '';
  let sizeBytes = 0;
  try {
    const lines: string[] = [];
    for (let from = fromSeq; from <= toSeq; from += PAGE) {
      const { rows } = await db.query(
        `SELECT seq::text AS seq, id::text AS id, at, user_id, role, action, patient_id::text AS patient_id, record_type, record_id,
                changes, reason, ip, device, prev_hash, hash
         FROM audit_events WHERE seq >= $1 AND seq <= $2 ORDER BY audit_events.seq LIMIT ${PAGE}`,
        [from, Math.min(toSeq, from + PAGE - 1)],
      );
      for (const r of rows) lines.push(JSON.stringify({ ...r, at: (r.at as Date).toISOString() }));
    }
    const body = await encryptForBackup(gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8')), recipient);
    const [y, m, d] = indiaDate(now).split('-');
    key = `audit/${env.STAGE}/${y}/${m}/${d}/${fromSeq}-${toSeq}.ndjson.gz.age`;
    sizeBytes = body.length;
    await files.put(key, body);
  } catch (error) {
    // Nothing counts as exported, so the next run tries the same range again.
    await recordRun(db, { startedAt, ok: false, detail: { error: error instanceof Error ? error.message : 'export failed', fromSeq, toSeq } });
    throw error;
  }
  summary(toSeq - fromSeq + 1, { key, sizeBytes });
  return finish({ detail: { exported: toSeq - fromSeq + 1, fromSeq, toSeq }, lastSeq: toSeq, s3Key: key, sizeBytes });
}
