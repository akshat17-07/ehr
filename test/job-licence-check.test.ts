import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { licenceCheck } from '../src/jobs/licence-check.js';
import { runJob } from '../src/jobs/index.js';

// 4 Nov 2026, 11:30 India time.
const NOW = new Date('2026-11-04T06:00:00Z');

async function fresh() {
  const db = await openLocalDb();
  await seedDev(db);
  return db;
}
const setHospital = (db: Awaited<ReturnType<typeof fresh>>, till: string | null) =>
  db.query('UPDATE hospital SET licence_valid_till = $1', [till]);
const alertsOf = async (db: Awaited<ReturnType<typeof fresh>>, sub: string) =>
  (await db.query('SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at, id', [sub])).rows as { kind: string; title: string; body: string; created_by: string }[];
const count = async (db: Awaited<ReturnType<typeof fresh>>) => (await db.query('SELECT count(*)::int AS n FROM alerts')).rows[0]!.n as number;
const run = (db: Awaited<ReturnType<typeof fresh>>) => licenceCheck({ db, now: NOW });

describe('licence_check job: hospital licence', () => {
  it('within 90 days: alerts settings.manage users only', async () => {
    const db = await fresh();
    await setHospital(db, '2027-01-02');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run(db);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ msg: 'job summary', job: 'licence_check', alertsCreated: 1, skippedUnchanged: 0 }));
    log.mockRestore();
    expect(await alertsOf(db, 'dev-admin')).toEqual([
      expect.objectContaining({
        kind: 'licence',
        title: 'Hospital licence',
        body: 'Hospital licence (MP) MP/BPL/2024/0101 valid till 02 Jan 2027: expires in 59 days',
        created_by: 'licence_check',
      }),
    ]);
    expect(await alertsOf(db, 'dev-head-doctor')).toHaveLength(0);
    // Idempotent.
    await run(db);
    expect(await count(db)).toBe(1);
  });

  it('exactly 90 days is in; 91 days is out', async () => {
    const db = await fresh();
    await setHospital(db, '2027-02-02');
    await run(db);
    expect(await count(db)).toBe(1);
    const other = await fresh();
    await setHospital(other, '2027-02-03');
    await run(other);
    expect(await count(other)).toBe(0);
  });

  it('expired, and not set', async () => {
    const db = await fresh();
    await setHospital(db, '2026-10-30');
    await run(db);
    expect((await alertsOf(db, 'dev-admin'))[0]!.body).toBe('Hospital licence (MP) MP/BPL/2024/0101 valid till 30 Oct 2026: expired 5 days ago');
    const none = await fresh();
    await setHospital(none, null);
    await run(none);
    expect((await alertsOf(none, 'dev-admin'))[0]!.body).toBe('Hospital licence valid-till date is not set');
  });
});

describe('licence_check job: doctors registrations', () => {
  const setReg = (db: Awaited<ReturnType<typeof fresh>>, sub: string, till: string) => db.query('UPDATE users SET reg_valid_till = $1 WHERE cognito_sub = $2', [till, sub]);

  it('a digest to settings.manage users and a personal alert to each doctor, sorted by date', async () => {
    const db = await fresh();
    await setReg(db, 'dev-doctor', '2026-12-31'); // day 57: in
    await setReg(db, 'dev-surgeon', '2026-11-01'); // expired
    await run(db);
    const admin = await alertsOf(db, 'dev-admin');
    expect(admin).toHaveLength(1);
    expect(admin[0]).toMatchObject({
      title: 'Doctor registrations',
      body: 'Registrations expired or expiring within 60 days: Dr Vikram Singh (MP-1003) 01 Nov 2026; Dr Neha Gupta (MP-1002) 31 Dec 2026',
    });
    expect(await alertsOf(db, 'dev-doctor')).toEqual([expect.objectContaining({ kind: 'licence', title: 'Your council registration', body: 'Your council registration MP-1002 is valid till 31 Dec 2026' })]);
    expect((await alertsOf(db, 'dev-surgeon'))[0]!.body).toBe('Your council registration MP-1003 is valid till 01 Nov 2026');
    expect(await alertsOf(db, 'dev-nurse')).toHaveLength(0);
    const before = await count(db);
    await run(db);
    expect(await count(db)).toBe(before);
  });

  it('61 days out and inactive doctors are left out', async () => {
    const db = await fresh();
    await setReg(db, 'dev-doctor', '2027-01-04'); // day 61
    await setReg(db, 'dev-surgeon', '2026-11-01');
    await db.query("UPDATE users SET active = false WHERE cognito_sub = 'dev-surgeon'");
    await run(db);
    expect(await count(db)).toBe(0);
  });

  it('more than 10 doctors: lists 10 and says "and N more"', async () => {
    const db = await fresh();
    for (let i = 0; i < 12; i++) {
      await db.query(
        `INSERT INTO users (id, status, created_by, updated_by, cognito_sub, name, email, mobile, type, department_ids, council_reg_no, reg_valid_till, active)
         VALUES ($1, 'active', 'x', 'x', $2, $3, $4, $5, 'doctor', '[]', $6, '2026-11-10', true)`,
        [randomUUID(), `doc-${i}`, `Dr Test ${String(i).padStart(2, '0')}`, `t${i}@x.in`, `97000000${String(i).padStart(2, '0')}`, `MP-9${i}`],
      );
    }
    await run(db);
    const body = (await alertsOf(db, 'dev-admin')).find((a) => a.title === 'Doctor registrations')!.body;
    expect(body.split('; ')).toHaveLength(11);
    expect(body.endsWith('; and 2 more')).toBe(true);
    expect(await alertsOf(db, 'doc-11')).toHaveLength(1);
  });

  it('runJob wires licence_check to a database', async () => {
    const db = await fresh();
    await setHospital(db, null);
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runJob({ job: 'licence_check' }, { db, now: NOW })).resolves.toEqual({ job: 'licence_check', ok: true });
    quiet.mockRestore();
    expect(await count(db)).toBe(1);
  });
});
