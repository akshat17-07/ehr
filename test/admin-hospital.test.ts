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
const head = asStaff('dev-head-doctor', ['head_doctor']);
const doctor = asStaff('dev-doctor', ['doctor']);

const send = (method: string, path: string, body: unknown, who = admin) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
type Hospital = { id: string; version: number; name: string; gstin?: string; invoicePrefix: string; billOfSupplyPrefix: string; refundLimitPaise: number; discountLimitPaise: number; address: { city: string } };
const patch = async (body: unknown, who = admin) => {
  const res = await send('PATCH', '/admin/hospital', body, who);
  return { status: res.status, body: (await res.json()) as Hospital & { error?: string } };
};
const current = async () => ((await (await app.request('/staff/hospital', {}, doctor)).json()) as Hospital);

describe('PATCH /admin/hospital', () => {
  it('changes details, keeps the history and reason, and staff see the new details', async () => {
    const before = await current();
    const { status, body } = await patch({
      version: before.version,
      name: 'Shanti Multispeciality Hospital & Research Centre',
      address: { line1: '12 Station Road', city: 'Indore', district: 'Indore', state: 'Madhya Pradesh', pincode: '452001' },
      gstin: '23abcde1234f1z5',
      licenceValidTill: '2027-03-31',
      reason: 'Licence renewed',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ version: before.version + 1, gstin: '23ABCDE1234F1Z5', licenceValidTill: '2027-03-31', address: { city: 'Indore' } });
    expect(await current()).toMatchObject({ name: 'Shanti Multispeciality Hospital & Research Centre', version: before.version + 1 });
    const history = await db.query('SELECT reason FROM hospital_versions WHERE record_id = $1', [before.id]);
    expect(history.rows.at(-1)).toMatchObject({ reason: 'Licence renewed' });
    const audit = await db.query("SELECT reason, changes FROM audit_events WHERE record_type = 'hospital' ORDER BY seq DESC LIMIT 1");
    expect(audit.rows[0]).toMatchObject({ reason: 'Licence renewed' });
    expect(Object.keys(JSON.parse(String(audit.rows[0]!.changes))).sort()).toEqual(['address', 'gstin', 'licenceValidTill', 'name']);
  });

  it('null clears an optional field; a field that is already so changes nothing', async () => {
    const before = await current();
    const { body } = await patch({ version: before.version, gstin: null });
    expect(body).not.toHaveProperty('gstin');
    expect((await patch({ version: body.version, gstin: null })).status).toBe(422);
    expect((await patch({ version: body.version, name: body.name })).status).toBe(422);
  });

  it('409 for a stale version; 422 for bad fields; 403 for anyone but the Admin', async () => {
    const { version } = await current();
    expect((await patch({ version: version - 1, name: 'Old news' })).status).toBe(409);
    expect((await patch({ version, gstin: '123' })).status).toBe(422);
    expect((await patch({ version, email: 'not-an-email' })).status).toBe(422);
    expect((await patch({ version, invoicePrefix: 'A/B' })).status).toBe(422);
    expect((await patch({ version, address: { line1: 'x', city: 'y', district: 'z', state: 's', pincode: '12' } })).status).toBe(422);
    expect((await patch({ version, refundLimitPaise: -1 })).status).toBe(422);
    expect((await patch({ version, colour: 'blue' })).status).toBe(422);
    expect((await patch({ name: 'No version' })).status).toBe(422);
    expect((await patch({ version, name: 'Not allowed' }, head)).status).toBe(403);
    expect((await patch({ version, name: 'Not allowed' }, doctor)).status).toBe(403);
  });
});

describe('the limits', () => {
  it('start at the defaults; a lower discount limit makes a smaller discount wait for approval; null restores the default', async () => {
    const start = await current();
    expect(await patch({ version: start.version, discountLimitPaise: 10_000 }).then((r) => r.body)).toMatchObject({ refundLimitPaise: 100_000, discountLimitPaise: 10_000 });
    const draft = (await (await send('POST', '/staff/bills', { patientId: seedId('9a710000', 3), lines: [{ text: 'Package', qty: 1, unitPaise: 500_000 }] }, doctor)).json()) as { id: string };
    const discount = await send('POST', `/staff/bills/${draft.id}/discounts`, { amountPaise: 20_000, reason: 'Staff family' }, doctor);
    expect(await discount.json()).toMatchObject({ status: 'pending' });
    const { body } = await patch({ version: (await current()).version, discountLimitPaise: null });
    expect(body.discountLimitPaise).toBe(100_000);
  });
});

describe('invoice prefixes', () => {
  const finalise = async (lines: unknown[]) => {
    const draft = (await (await send('POST', '/staff/bills', { patientId: seedId('9a710000', 3), lines }, doctor)).json()) as { id: string; version: number };
    return (await (await send('POST', `/staff/bills/${draft.id}/finalise`, { version: draft.version }, doctor)).json()) as { number: string; series: string };
  };

  it('each changes before the first numbered bill of its series in the financial year, then is locked; the other series stays free', async () => {
    // a plain text line has no GST: bill of supply. A tariff with GST: tax invoice.
    const { rows } = await db.query('SELECT id FROM tariffs ORDER BY id LIMIT 1');
    await db.query('UPDATE tariffs SET gst_rate = 18 WHERE id = $1', [rows[0]!.id]);
    const taxed = [{ tariffId: String(rows[0]!.id), qty: 1 }];
    const plain = [{ text: 'Package', qty: 1, unitPaise: 1000 }];

    const first = await patch({ version: (await current()).version, invoicePrefix: 'smh', billOfSupplyPrefix: 'bos1' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ invoicePrefix: 'SMH', billOfSupplyPrefix: 'BOS1' });

    const supply = await finalise(plain);
    expect(supply).toMatchObject({ series: 'bill_of_supply' });
    expect(supply.number).toMatch(/^BOS1\/\d\d-\d\d\/\d+$/);
    const locked = await patch({ version: (await current()).version, billOfSupplyPrefix: 'BOS2' });
    expect(locked.status).toBe(409);
    expect(locked.body.error).toBe('prefix_in_use');
    // the invoice prefix is still free: no tax invoice yet
    expect((await patch({ version: (await current()).version, invoicePrefix: 'smh2' })).body.invoicePrefix).toBe('SMH2');

    const invoice = await finalise(taxed);
    expect(invoice).toMatchObject({ series: 'tax_invoice' });
    expect(invoice.number).toMatch(/^SMH2\/\d\d-\d\d\/\d+$/);
    expect((await patch({ version: (await current()).version, invoicePrefix: 'XYZ' })).status).toBe(409);
    // the same prefix again is no change of prefix; other details still change
    expect((await patch({ version: (await current()).version, name: 'Name still changes', invoicePrefix: 'SMH2' })).status).toBe(200);
  });
});
