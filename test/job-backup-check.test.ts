import { describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { backupCheck } from '../src/jobs/backup-check.js';
import { runJob } from '../src/jobs/index.js';
import { addRun } from './job-runs-fixture.js';

const NOW = new Date('2026-11-05T02:00:00Z');
const fresh = async () => {
  const db = await openLocalDb();
  await seedDev(db);
  return db;
};
const checks = async (db: Awaited<ReturnType<typeof fresh>>) => (await db.query("SELECT * FROM job_runs WHERE job = 'backup_check' ORDER BY started_at, id")).rows;
const quiet = () => [vi.spyOn(console, 'log').mockImplementation(() => undefined), vi.spyOn(console, 'warn').mockImplementation(() => undefined)];

describe('backup_check job', () => {
  it('prod, fresh backups: records ok', async () => {
    env.STAGE = 'prod';
    const db = await fresh();
    await addRun(db, 'backup_export', 3);
    await addRun(db, 'audit_export', 2);
    const spies = quiet();
    await backupCheck({ db, now: NOW });
    spies.forEach((s) => s.mockRestore());
    expect(await checks(db)).toEqual([expect.objectContaining({ ok: true })]);
    env.STAGE = 'dev';
  });

  it('prod, stale backup: records ok=false and throws naming the problem', async () => {
    env.STAGE = 'prod';
    const db = await fresh();
    await addRun(db, 'backup_export', 27);
    await addRun(db, 'audit_export', 2);
    const spies = quiet();
    await expect(backupCheck({ db, now: NOW })).rejects.toThrow('backup_export: no successful run in 26h');
    spies.forEach((s) => s.mockRestore());
    const row = (await checks(db))[0]!;
    expect(row).toMatchObject({ ok: false });
    expect(JSON.parse(String(row.detail)).problems).toEqual(['backup_export: no successful run in 26h']);
    env.STAGE = 'dev';
  });

  it('non-prod with no backups: skipped row, no throw; prod with none throws', async () => {
    env.STAGE = 'dev';
    const db = await fresh();
    const spies = quiet();
    await backupCheck({ db, now: NOW });
    expect(await checks(db)).toEqual([expect.objectContaining({ ok: true, detail: '{"skipped":"non-prod, no backups"}' })]);
    env.STAGE = 'prod';
    await expect(backupCheck({ db, now: NOW })).rejects.toThrow('Backup check failed');
    spies.forEach((s) => s.mockRestore());
    env.STAGE = 'dev';
  });

  it('runs through runJob', async () => {
    const db = await fresh();
    const spies = quiet();
    await expect(runJob({ job: 'backup_check' }, { db, now: NOW })).resolves.toEqual({ job: 'backup_check', ok: true });
    spies.forEach((s) => s.mockRestore());
  });
});
