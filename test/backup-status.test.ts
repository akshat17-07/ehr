import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { addRun } from './job-runs-fixture.js';
import { backupStatus } from '../src/jobs/backup-status.js';

const NOW = new Date('2026-11-05T02:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const fresh = async () => {
  const db = await openLocalDb();
  await seedDev(db);
  return db;
};

describe('backupStatus', () => {
  it('both jobs fresh: ok, no problems, export time and size', async () => {
    const db = await fresh();
    await addRun(db, 'backup_export', 3, { size: 5000 });
    await addRun(db, 'audit_export', 2);
    const s = await backupStatus(db, NOW);
    expect(s).toMatchObject({ ok: true, problems: [], lastExportAt: hoursAgo(3).toISOString(), lastExportSizeBytes: 5000, lastPcDownloadAt: null, lastRestoreDrillAt: null });
    expect(s.jobs).toHaveLength(2);
  });

  it('a 27 hour old export and a missing audit export are problems', async () => {
    const db = await fresh();
    await addRun(db, 'backup_export', 27);
    const s = await backupStatus(db, NOW);
    expect(s.ok).toBe(false);
    expect(s.problems).toEqual(['backup_export: no successful run in 26h', 'audit_export: no successful run in 26h']);
  });

  it('a failed run after a fresh success is not ok', async () => {
    const db = await fresh();
    await addRun(db, 'backup_export', 5);
    await addRun(db, 'audit_export', 5);
    await addRun(db, 'backup_export', 1, { ok: false, key: null, size: null });
    const s = await backupStatus(db, NOW);
    expect(s.ok).toBe(false);
    expect(s.problems).toEqual(['backup_export: last run failed']);
    expect(s.jobs[0]).toMatchObject({ fresh: true, lastRunOk: false });
  });

  it('skipped runs (no s3 key) are not a success', async () => {
    const db = await fresh();
    await addRun(db, 'backup_export', 1, { key: null, size: null });
    await addRun(db, 'audit_export', 1, { key: null, size: null });
    const s = await backupStatus(db, NOW);
    expect(s.ok).toBe(false);
    expect(s.lastExportAt).toBeNull();
    expect(s.jobs.every((j) => !j.fresh)).toBe(true);
  });
});

describe('GET /admin/backup-status', () => {
  const as = (sub: string, g: string) =>
    ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${g}]` } } } } } }) as never;

  it('200 with the BackupStatus shape for settings.view; 403 without; 401 not signed in', async () => {
    const db = await fresh();
    await addRun(db, 'backup_export', 0.5);
    await addRun(db, 'audit_export', 0.5);
    const app = createApp({ db: async () => db });
    const res = await app.request('/admin/backup-status', {}, as('dev-admin', 'admin'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: expect.any(Boolean), lastExportAt: expect.any(String), lastExportSizeBytes: 1234, lastPcDownloadAt: null, lastRestoreDrillAt: null, jobs: expect.any(Array), problems: expect.any(Array) });
    expect((await app.request('/admin/backup-status', {}, as('dev-reception', 'reception'))).status).toBe(403);
    expect((await app.request('/admin/backup-status')).status).toBe(401);
  });
});
