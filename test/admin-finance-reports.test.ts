import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);
const get = (path: string, who = admin) => app.request(path, {}, who);
const patient = seedId('9a710000', 1);
const med = seedId('de000000', 1);
const surgeon = seedId('a0000000', 4);
const doctorId = seedId('a0000000', 3);

async function bill(opts: { status: string; total: number; at: string; encounterId?: string; voided?: boolean }): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO bills (id, status, created_by, updated_by, created_at, updated_at, voided_at, patient_id, encounter_id, series, lines, subtotal_paise, gst_paise, total_paise, finalised_at)
     VALUES (gen_random_uuid(), $1, 'x', 'x', $2, $2, $3, $4, $5, 'tax_invoice', '[]', $6, 0, $6, $2) RETURNING id`,
    [opts.status, opts.at, opts.voided ? opts.at : null, patient, opts.encounterId ?? null, opts.total],
  );
  return String(rows[0]?.id);
}
const pay = (billId: string, amount: number, mode: string, at: string, voided = false) =>
  db.query(
    `INSERT INTO payments (id, status, created_by, updated_by, created_at, updated_at, voided_at, bill_id, patient_id, amount_paise, mode)
     VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $1, $2, $3, $4, $5, $6)`,
    [at, voided ? at : null, billId, patient, amount, mode],
  );
const refund = (billId: string, amount: number, mode: string, at: string, approvedAt: string | null = null) =>
  db.query(
    `INSERT INTO refunds (id, status, created_by, updated_by, created_at, updated_at, approved_at, bill_id, patient_id, amount_paise, mode, reason)
     VALUES (gen_random_uuid(), 'approved', 'x', 'x', $1, $1, $2, $3, $4, $5, $6, 'r')`,
    [at, approvedAt, billId, patient, amount, mode],
  );

describe('GET /admin/reports/surgery-margin', () => {
  it('charges less venue payments per surgery, voided and cancelled handled, totals exact', async () => {
    const surg = async (at: string, status: string, charges: number, surgeonId = surgeon, voided = false) =>
      String(
        (
          await db.query(
            `INSERT INTO surgeries (id, status, created_by, updated_by, voided_at, patient_id, procedure, surgeon_id, team_ids, scheduled_at, venue, charges_paise, consent_document_ids)
             VALUES (gen_random_uuid(), $1, 'x', 'x', $2, $3, 'P', $4, '[]', $5, 'own', $6, '[]') RETURNING id`,
            [status, voided ? at : null, patient, surgeonId, at, charges],
          )
        ).rows[0]?.id,
      );
    const venue = (surgeryId: string, amount: number, voided = false) =>
      db.query(
        `INSERT INTO venue_payments (id, status, created_by, updated_by, voided_at, surgery_id, partner_hospital_id, amount_paise, paid_on, mode)
         VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $2, gen_random_uuid(), $3, '2023-03-10', 'cash')`,
        [voided ? '2023-03-10T00:00:00Z' : null, surgeryId, amount],
      );
    // 2023-03-09T20:00Z is 2023-03-10 01:30 in India.
    const a = await surg('2023-03-09T20:00:00Z', 'done', 4_500_001);
    await venue(a, 1_000_001);
    await venue(a, 999_999, true);
    const b = await surg('2023-03-12T05:00:00Z', 'scheduled', 2_000_000, doctorId);
    const cancelled = await surg('2023-03-11T05:00:00Z', 'cancelled', 3_000_000);
    await venue(cancelled, 50_000);
    await surg('2023-03-11T06:00:00Z', 'cancelled', 3_000_000);
    await surg('2023-03-11T07:00:00Z', 'done', 9_000_000, surgeon, true);
    await surg('2023-03-09T18:00:00Z', 'done', 7_000_000); // 2023-03-09 23:30 India: before the range

    const res = await get('/admin/reports/surgery-margin?from=2023-03-10&to=2023-03-12');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rows: [
        { surgeryId: a, surgeryDate: '2023-03-10', chargesPaise: 4_500_001, venuePaidPaise: 1_000_001, marginPaise: 3_500_000 },
        { surgeryId: cancelled, surgeryDate: '2023-03-11', chargesPaise: 0, venuePaidPaise: 50_000, marginPaise: -50_000 },
        { surgeryId: b, surgeryDate: '2023-03-12', chargesPaise: 2_000_000, venuePaidPaise: 0, marginPaise: 2_000_000 },
      ],
      totals: { chargesPaise: 6_500_001, venuePaidPaise: 1_050_001, marginPaise: 5_450_000 },
    });
    const one = (await (await get(`/admin/reports/surgery-margin?from=2023-03-10&to=2023-03-12&surgeonId=${doctorId}`)).json()) as { rows: { surgeryId: string }[] };
    expect(one.rows.map((r) => r.surgeryId)).toEqual([b]);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'report' AND reason LIKE 'surgery-margin from=2023-03-10%'");
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('empty range, 403 and 422', async () => {
    expect(await (await get('/admin/reports/surgery-margin?from=2001-01-01&to=2001-01-31')).json()).toEqual({
      rows: [],
      totals: { chargesPaise: 0, venuePaidPaise: 0, marginPaise: 0 },
    });
    expect((await get('/admin/reports/surgery-margin?from=2023-03-10&to=2023-03-12', doctor)).status).toBe(403);
    for (const q of ['from=2023-03-12&to=2023-03-10', 'from=2023-03-12', 'to=2023-03-12', 'from=2022-01-01&to=2023-01-02', 'from=2023-03-01&to=2023-03-02&surgeonId=x']) {
      expect((await get(`/admin/reports/surgery-margin?${q}`)).status).toBe(422);
    }
    expect((await get('/admin/reports/surgery-margin?from=2022-01-01&to=2023-01-01')).status).toBe(200);
  });
});

describe('GET /admin/reports/collections', () => {
  it('billed, collected and refunded by day, department and mode; voided and drafts left out', async () => {
    const enc = String(
      (
        await db.query(
          `INSERT INTO encounters (id, status, created_by, updated_by, patient_id, type, department_id, doctor_id, started_at)
           VALUES (gen_random_uuid(), 'closed', 'x', 'x', $1, 'OPD', $2, $3, '2024-05-01T00:00:00Z') RETURNING id`,
          [patient, med, doctorId],
        )
      ).rows[0]?.id,
    );
    // 2024-05-10T19:00Z is 2024-05-11 00:30 in India.
    const b1 = await bill({ status: 'part_paid', total: 100_001, at: '2024-05-10T06:00:00Z', encounterId: enc });
    const b2 = await bill({ status: 'paid', total: 50_000, at: '2024-05-10T19:00:00Z' });
    await bill({ status: 'draft', total: 777_777, at: '2024-05-10T06:00:00Z' });
    await bill({ status: 'void', total: 888_888, at: '2024-05-10T06:00:00Z', voided: true });
    await pay(b1, 40_000, 'cash', '2024-05-10T07:00:00Z');
    await pay(b1, 30_001, 'upi', '2024-05-10T08:00:00Z');
    await pay(b1, 5_555, 'cash', '2024-05-10T08:00:00Z', true);
    await pay(b2, 20_000, 'deposit', '2024-05-10T19:00:00Z');
    await pay(b2, 30_000, 'cash', '2024-05-10T19:00:00Z');
    await db.query(
      `INSERT INTO deposits (id, status, created_by, updated_by, created_at, updated_at, patient_id, receipt_no, amount_paise, balance_paise, mode)
       VALUES (gen_random_uuid(), 'active', 'x', 'x', '2024-05-10T09:00:00Z', '2024-05-10T09:00:00Z', $1, 'R-REPORT-1', 20_000, 0, 'card')`,
      [patient],
    );
    await refund(b1, 10_000, 'cash', '2024-05-10T10:00:00Z');
    await refund(b2, 5_000, 'upi', '2024-05-09T10:00:00Z', '2024-05-10T19:30:00Z'); // approved on the 11th in India

    const q = (g: string) => `/admin/reports/collections?from=2024-05-10&to=2024-05-11${g}`;
    const day = (await (await get(q(''))).json()) as { rows: unknown[] };
    expect(day.rows).toEqual([
      { key: '2024-05-10', billedPaise: 100_001, collectedPaise: 90_001, refundedPaise: 10_000 },
      { key: '2024-05-11', billedPaise: 50_000, collectedPaise: 30_000, refundedPaise: 5_000 },
    ]);
    expect(((await (await get(q('&groupBy=day'))).json()) as { rows: unknown[] }).rows).toEqual(day.rows);

    const dept = ((await (await get(q('&groupBy=department'))).json()) as { rows: unknown[] }).rows;
    expect(dept).toEqual([
      { key: med, billedPaise: 100_001, collectedPaise: 70_001, refundedPaise: 10_000 },
      { key: 'unassigned', billedPaise: 50_000, collectedPaise: 50_000, refundedPaise: 5_000 },
    ].sort((x, y) => x.key.localeCompare(y.key)));

    const mode = ((await (await get(q('&groupBy=mode'))).json()) as { rows: unknown[] }).rows;
    expect(mode).toEqual([
      { key: 'card', billedPaise: 0, collectedPaise: 20_000, refundedPaise: 0 },
      { key: 'cash', billedPaise: 0, collectedPaise: 70_000, refundedPaise: 10_000 },
      { key: 'upi', billedPaise: 0, collectedPaise: 30_001, refundedPaise: 5_000 },
    ]);

    // Agrees with day close for the 10th: cash+upi+card less refunds.
    const close = (await (await get('/staff/reports/day-close?date=2024-05-10')).json()) as { netPaise: number };
    expect(close.netPaise).toBe(90_001 - 10_000);
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'report' AND reason LIKE 'collections from=2024-05-10 to=2024-05-11 groupBy=department'");
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('empty range, 403 and 422', async () => {
    expect(await (await get('/admin/reports/collections?from=2001-01-01&to=2001-01-31&groupBy=mode')).json()).toEqual({ rows: [] });
    expect((await get('/admin/reports/collections?from=2024-05-10&to=2024-05-11', doctor)).status).toBe(403);
    for (const q of ['from=2024-05-12&to=2024-05-10', 'to=2024-05-10', 'from=2023-01-01&to=2024-05-10', 'from=2024-05-10&to=2024-05-11&groupBy=week']) {
      expect((await get(`/admin/reports/collections?${q}`)).status).toBe(422);
    }
  });
});
