import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { runJob } from '../src/jobs/index.js';
import { retentionCounts, retentionReview } from '../src/jobs/retention-review.js';

// 2 Dec 2026, 08:30 India time.
const NOW = new Date('2026-12-02T03:00:00Z');
type Db = Awaited<ReturnType<typeof fresh>>;
const p = (n: number) => seedId('9a710000', n);

async function fresh() {
  const db = await openLocalDb();
  await seedDev(db);
  // Everyone starts as recently active.
  await db.query('UPDATE patients SET last_activity_at = $1, dob = NULL', [new Date('2026-11-01T00:00:00Z')]);
  return db;
}
const patient = (db: Db, n: number, set: string, value: unknown) => db.query(`UPDATE patients SET ${set} WHERE id = $2`, [value, p(n)]);
const old = (db: Db, n: number) => patient(db, n, 'last_activity_at = $1', new Date('2015-06-01T00:00:00Z'));
async function bill(db: Db, patientId: string, finalisedAt: string, status = 'final') {
  await db.query(
    `INSERT INTO bills (id, status, created_by, updated_by, created_at, updated_at, patient_id, series, lines, subtotal_paise, gst_paise, total_paise, finalised_at)
     VALUES ($1, $2, 't', 't', $3, $3, $4, 'OPD', '[]', 100, 0, 100, $3)`,
    [randomUUID(), status, finalisedAt, patientId],
  );
}
const alerts = async (db: Db) => (await db.query('SELECT * FROM alerts ORDER BY created_at, id')).rows as { user_id: string; kind: string; title: string; body: string; link: string }[];
const runs = async (db: Db) => (await db.query("SELECT * FROM job_runs WHERE job = 'retention_review'")).rows;
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);
const tableCounts = async (db: Db) =>
  JSON.stringify([
    (await db.query('SELECT count(*)::int AS n, sum(version)::int AS v, count(voided_at)::int AS x FROM patients')).rows,
    (await db.query('SELECT count(*)::int AS n, sum(version)::int AS v, count(voided_at)::int AS x FROM bills')).rows,
    (await db.query('SELECT count(*)::int AS n FROM patients_versions')).rows,
  ]);

describe('retention_review job', () => {
  it('counts each category; nothing else is counted', async () => {
    const db = await fresh();
    await old(db, 1); // due
    await old(db, 2);
    await patient(db, 2, 'dob = $1', '2015-01-01'); // minor: 11 years old
    await old(db, 3);
    await patient(db, 3, 'labels = $1', JSON.stringify(['mtp'])); // permanent
    await old(db, 4);
    await db.query(
      `INSERT INTO legal_holds (id, status, created_by, updated_by, patient_id, reason) VALUES ($1, 'active', 't', 't', $2, 'MLC')`,
      [randomUUID(), p(4)],
    ); // on hold
    await old(db, 5);
    await patient(db, 5, "voided_at = $1, voided_by = 't', void_reason = 'dup'", new Date()); // voided
    await bill(db, p(2), '2018-01-01T00:00:00Z'); // due
    await bill(db, p(2), '2025-01-01T00:00:00Z'); // recent
    await bill(db, p(2), '2018-01-01T00:00:00Z', 'draft'); // not issued
    expect(await retentionCounts(db, NOW)).toEqual({ patients: 1, bills: 1, onHold: 1, permanent: 1 });
  });

  it('no dob: the age given at registration protects a child; an adult age does not', async () => {
    const db = await fresh();
    for (const n of [1, 2]) {
      await old(db, n);
      await patient(db, n, 'created_at = $1', new Date('2015-06-01T00:00:00Z'));
    }
    await patient(db, 1, 'age_years = $1', 5); // born about 2010: 16 now
    await patient(db, 2, 'age_years = $1', 40); // born about 1975
    expect(await retentionCounts(db, NOW)).toMatchObject({ patients: 1 });
    // Neither dob nor age: activity only.
    await patient(db, 1, 'age_years = $1', null);
    expect(await retentionCounts(db, NOW)).toMatchObject({ patients: 2 });
  });

  it('alerts settings.view users once, changes nothing, and records the run', async () => {
    const db = await fresh();
    await old(db, 1);
    await bill(db, p(2), '2018-01-01T00:00:00Z');
    const before = await tableCounts(db);
    const log = quiet();
    await retentionReview({ db, now: NOW });
    const made = await alerts(db);
    expect(made.length).toBeGreaterThan(0);
    expect(made.map((a) => a.user_id)).toContain('dev-admin');
    expect(made[0]).toMatchObject({
      kind: 'compliance',
      title: 'Retention review',
      body: '1 patient records and 1 bills are past the retention period. Nothing is deleted automatically.',
      link: '/admin/compliance',
    });
    expect(await tableCounts(db)).toBe(before);
    expect(JSON.parse(String((await runs(db))[0]!.detail))).toEqual({ patients: 1, bills: 1, onHold: 0, permanent: 0 });
    // Unchanged counts: no new alert; changed counts: a new one.
    await retentionReview({ db, now: NOW });
    expect(await alerts(db)).toHaveLength(made.length);
    await bill(db, p(2), '2017-01-01T00:00:00Z');
    await retentionReview({ db, now: NOW });
    log.mockRestore();
    expect((await alerts(db)).length).toBe(made.length * 2);
    expect(await runs(db)).toHaveLength(3);
  });

  it('no alert when nothing is due, but the run is recorded', async () => {
    const db = await fresh();
    const log = quiet();
    await retentionReview({ db, now: NOW });
    log.mockRestore();
    expect(await alerts(db)).toHaveLength(0);
    expect(JSON.parse(String((await runs(db))[0]!.detail))).toEqual({ patients: 0, bills: 0, onHold: 0, permanent: 0 });
    expect((await runs(db))[0]).toMatchObject({ ok: true });
  });

  it('runJob wires the job to a database', async () => {
    const db = await fresh();
    await old(db, 1);
    const log = quiet();
    await expect(runJob({ job: 'retention_review' }, { db, now: NOW })).resolves.toEqual({ job: 'retention_review', ok: true });
    log.mockRestore();
    expect((await alerts(db)).length).toBeGreaterThan(0);
  });
});
