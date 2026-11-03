import type { BackupFiles } from '../backup/files.js';
import type { Queryable } from '../db/migrate.js';
import { createAlert, type AlertKind } from '../modules/alerts/alerts.js';

// Shared by the alert-raising jobs. At most one alert per (recipient, kind, title) per run, and none if that
// recipient's latest alert of the same kind and title already says the same thing (nothing changed since last run).

export interface JobDeps {
  db: Queryable;
  now?: Date;
  /** Where backup files go; the real backup bucket when not given. */
  backupFiles?: BackupFiles;
}

export interface Tally {
  alertsCreated: number;
  skippedUnchanged: number;
}

export interface Digest {
  kind: AlertKind;
  title: string;
  body: string;
  link?: string;
}

export async function raiseIfChanged(db: Queryable, userId: string, digest: Digest, by: string, tally: Tally): Promise<void> {
  const { rows } = await db.query(
    'SELECT body FROM alerts WHERE user_id = $1 AND kind = $2 AND title = $3 ORDER BY created_at DESC, id DESC LIMIT 1',
    [userId, digest.kind, digest.title],
  );
  if (rows[0] && String(rows[0].body) === digest.body) {
    tally.skippedUnchanged++;
    return;
  }
  await createAlert(db, { userId, by, ...digest });
  tally.alertsCreated++;
}

export const logSummary = (job: string, tally: Tally) =>
  console.log(JSON.stringify({ msg: 'job summary', job, alertsCreated: tally.alertsCreated, skippedUnchanged: tally.skippedUnchanged }));
