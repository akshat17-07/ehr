import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { runJob } from '../src/jobs/index.js';
import { pcpndtMonthlyJob, previousMonth } from '../src/jobs/pcpndt-monthly.js';
import { usersWithPermission } from '../src/permissions/check.js';

// 30 Nov 2025 19:00 UTC = 1 Dec 00:30 India time: the India month is December, the UTC month is still November.
const NOW = new Date('2025-11-30T19:00:00Z');
type Db = Awaited<ReturnType<typeof fresh>>;

async function fresh() {
  const db = await openLocalDb();
  await seedDev(db);
  return db;
}
async function formF(db: Db, createdAt: string) {
  await db.query(
    `INSERT INTO form_f (id, status, created_by, updated_by, created_at, updated_at, encounter_id, patient_id, doctor_id, indication, procedure, declaration_signed)
     VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $1, $2, $3, $4, 'Dating scan', 'Ultrasound, obstetric', true)`,
    [createdAt, randomUUID(), seedId('9a710000', 1), seedId('a0000000', 3)],
  );
}
const alerts = async (db: Db) => (await db.query('SELECT * FROM alerts ORDER BY created_at, id')).rows as { user_id: string; kind: string; title: string; body: string; link: string; created_by: string }[];
const runs = async (db: Db) => (await db.query("SELECT * FROM job_runs WHERE job = 'pcpndt_monthly'")).rows;
const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

describe('pcpndt_monthly job', () => {
  it('uses the India month before now (January gives December)', () => {
    expect(previousMonth(NOW)).toBe('2025-11');
    expect(previousMonth(new Date('2026-01-02T20:00:00Z'))).toBe('2025-12');
    expect(previousMonth(new Date('2026-01-03T00:30:00Z'))).toBe('2025-12');
  });

  it('counts last month\'s Forms F and alerts compliance.registers holders only', async () => {
    const db = await fresh();
    await formF(db, '2025-10-15T10:00:00Z');
    await formF(db, '2025-11-05T10:00:00Z');
    await formF(db, '2025-11-20T10:00:00Z');
    await formF(db, '2025-12-01T10:00:00Z');
    const log = quiet();
    await pcpndtMonthlyJob({ db, now: NOW });
    log.mockRestore();
    const holders = await usersWithPermission(db, 'compliance.registers', NOW);
    expect(holders.length).toBeGreaterThan(0);
    expect(holders).not.toContain('dev-nurse');
    const made = await alerts(db);
    expect(made.map((a) => a.user_id).sort()).toEqual([...holders].sort());
    expect(made[0]).toMatchObject({
      kind: 'compliance',
      title: 'PCPNDT monthly report for Nov 2025 is ready',
      body: '2 Forms F (due to the Appropriate Authority by the 5th)',
      link: '/admin/registers/pcpndt-monthly?month=2025-11',
      created_by: 'pcpndt_monthly',
    });
    expect(JSON.stringify(made)).not.toMatch(/Kavita|Irfan|UHID/i);
    const [run] = await runs(db);
    expect(run).toMatchObject({ ok: true });
    expect(JSON.parse(String(run!.detail))).toEqual({ month: '2025-11', forms: 2, alertsCreated: holders.length });
  });

  it('a nil month still alerts, with 0 forms; a second run does not repeat it', async () => {
    const db = await fresh();
    const log = quiet();
    await pcpndtMonthlyJob({ db, now: NOW });
    const first = (await alerts(db)).length;
    expect(first).toBeGreaterThan(0);
    expect((await alerts(db))[0]!.body).toBe('0 Forms F (due to the Appropriate Authority by the 5th)');
    await pcpndtMonthlyJob({ db, now: NOW });
    log.mockRestore();
    expect((await alerts(db)).length).toBe(first);
    expect(await runs(db)).toHaveLength(2);
  });

  it('runJob wires the job to a database', async () => {
    const db = await fresh();
    const log = quiet();
    await expect(runJob({ job: 'pcpndt_monthly' }, { db, now: NOW })).resolves.toEqual({ job: 'pcpndt_monthly', ok: true });
    log.mockRestore();
    expect((await alerts(db)).length).toBeGreaterThan(0);
  });

  it('an error is recorded as a failed run and thrown', async () => {
    const db = await fresh();
    await db.query('DROP TABLE form_f');
    const log = quiet();
    await expect(pcpndtMonthlyJob({ db, now: NOW })).rejects.toThrow();
    log.mockRestore();
    expect(await runs(db)).toMatchObject([{ ok: false }]);
  });
});
