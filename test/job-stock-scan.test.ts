import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { JOB_NAMES, runJob } from '../src/jobs/index.js';
import { stockScan } from '../src/jobs/stock-scan.js';

const db = await openLocalDb();
await seedDev(db);
// The dev seed has batches of its own; these tests count only their own.
await db.query('UPDATE batches SET qty_on_hand = 0');
// 4 Nov 2026, 11:30 India time.
const NOW = new Date('2026-11-04T06:00:00Z');
const CREATED = new Date('2026-01-01T00:00:00Z');

let n = 100;
async function item(name: string) {
  const id = seedId('17e00000', n++);
  await db.query(
    `INSERT INTO items (id, status, created_at, updated_at, created_by, updated_by, name, kind, unit, pack_size, hsn, gst_rate, mrp_paise)
     VALUES ($1, 'active', $2, $2, 'x', 'x', $3, 'consumable', 'roll', 12, '3005', 12, 4500)`,
    [id, CREATED, name],
  );
  return id;
}
async function batch(itemId: string, batchNo: string, expiry: string, qty: number, recalled = false) {
  await db.query(
    `INSERT INTO batches (id, status, created_at, updated_at, created_by, updated_by, item_id, batch_no, expiry, cost_paise, mrp_paise, qty_on_hand, recalled)
     VALUES ($1, 'active', $2, $2, 'x', 'x', $3, $4, $5, 3000, 4500, $6, $7)`,
    [randomUUID(), CREATED, itemId, batchNo, expiry, qty, recalled],
  );
}
const alertsOf = async (sub: string) =>
  (await db.query('SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at, id', [sub])).rows as { kind: string; title: string; body: string; link: string; created_by: string }[];
const run = (at = NOW) => stockScan({ db, now: at });

describe('stock_scan job', () => {
  it('raises one expiry digest and one recall digest for stock.view users only', async () => {
    const gauze = await item('Gauze');
    const saline = await item('Saline');
    await batch(gauze, 'G1', '2026-11-03', 5); // expired
    await batch(gauze, 'G2', '2026-11-04', 5); // today: within 30 days
    await batch(gauze, 'G3', '2026-12-04', 5); // day 30
    await batch(gauze, 'G4', '2026-12-05', 5); // day 31
    await batch(saline, 'S1', '2027-02-02', 5); // day 90
    await batch(saline, 'S2', '2027-02-03', 5); // beyond 90: ignored
    await batch(saline, 'S3', '2026-11-10', 0); // no stock: ignored
    await batch(saline, 'RC1', '2028-01-01', 4, true); // recalled with stock
    await batch(gauze, 'RC0', '2028-01-01', 0, true); // recalled, returned: ignored

    // A nurse has no stock.view; a per-user allow gives it; an inactive user gets nothing.
    await db.query(`INSERT INTO user_permissions (id, status, created_by, updated_by, user_id, allow, deny) VALUES ($1, 'active', 'x', 'x', 'dev-nurse', '["stock.view"]', '[]')`, [randomUUID()]);
    await db.query("UPDATE users SET active = false WHERE cognito_sub = 'dev-medical'");

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ msg: 'job summary', job: 'stock_scan', alertsCreated: 6, skippedUnchanged: 0 }));
    log.mockRestore();

    for (const sub of ['dev-admin', 'dev-head-doctor', 'dev-nurse']) {
      const alerts = await alertsOf(sub);
      expect(alerts).toHaveLength(2);
      const expiry = alerts.find((a) => a.kind === 'expiry')!;
      expect(expiry).toMatchObject({
        title: 'Stock expiry',
        body: 'Expired with stock: 1. Expiring in 30 days: 2. Expiring in 31-90 days: 2.',
        link: '/stock/alerts?kind=expiry',
        created_by: 'stock_scan',
      });
      expect(alerts.find((a) => a.kind === 'recall')).toMatchObject({
        title: 'Recalled stock on hand',
        body: 'Recalled batches with stock: 1. Saline RC1.',
        link: '/stock/alerts?kind=recall',
      });
    }
    for (const sub of ['dev-medical', 'dev-doctor', 'dev-reception']) expect(await alertsOf(sub)).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM alerts WHERE title ILIKE '%low%'")).rows).toHaveLength(0);
  });

  it('a second run the same night creates nothing; a change in stock creates a new alert', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM alerts')).rows[0]!.n as number;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ msg: 'job summary', job: 'stock_scan', alertsCreated: 0, skippedUnchanged: 6 }));
    log.mockRestore();
    expect((await db.query('SELECT count(*)::int AS n FROM alerts')).rows[0]!.n).toBe(before);

    await batch(await item('Syringe'), 'SY1', '2026-11-20', 9);
    await run();
    const alerts = await alertsOf('dev-admin');
    expect(alerts).toHaveLength(3);
    expect(alerts.filter((a) => a.kind === 'expiry').pop()!.body).toBe('Expired with stock: 1. Expiring in 30 days: 3. Expiring in 31-90 days: 2.');
    expect((await db.query('SELECT count(*)::int AS n FROM alerts')).rows[0]!.n).toBe(before + 3);
  });

  it('no alerts at all when nothing expires or is recalled', async () => {
    await db.query('UPDATE batches SET qty_on_hand = 0');
    const before = (await db.query('SELECT count(*)::int AS n FROM alerts')).rows[0]!.n as number;
    await run();
    expect((await db.query('SELECT count(*)::int AS n FROM alerts')).rows[0]!.n).toBe(before);
  });

  it('runJob wires the job to a database; the other five jobs are still not built', async () => {
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runJob({ job: 'stock_scan' }, { db, now: NOW })).resolves.toEqual({ job: 'stock_scan', ok: true });
    quiet.mockRestore();
    for (const job of JOB_NAMES.filter((j) => j !== 'stock_scan' && j !== 'licence_check' && j !== 'audit_export' && j !== 'backup_export')) {
      await expect(runJob({ job })).rejects.toThrow(`Job ${job} is not built yet`);
    }
  });
});
