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
const doctor = asStaff('dev-doctor', ['doctor']);
const nurse = asStaff('dev-nurse', ['nurse']);
const reception = asStaff('dev-reception', ['staff']);
const ramesh = seedId('9a710000', 1);
const drug = (n: number) => seedId('d0000000', n);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// Ramesh (allergic to Penicillin, moderate) arrives: appointment 1 opens his encounter.
const arrived = await app.request(`/staff/appointments/${seedId('a9900000', 1)}/check-in`, { method: 'POST' }, reception);
const encounterId = ((await arrived.json()) as { encounter: { id: string } }).encounter.id;

const line = (drugText: string, more: Record<string, unknown> = {}) => ({ drugText, dose: '1 tablet', frequency: 'twice a day', days: 5, ...more });
const prescribe = (body: unknown, encounter = encounterId, who = doctor) => app.request(`/staff/encounters/${encounter}/prescriptions`, json(body), who);
type Alert = { id: string; severity: string; kind: string; lineIndex: number };

describe('POST /staff/encounters/{id}/prescriptions', () => {
  it('saves a typed prescription, confirmed, by the signed-in doctor', async () => {
    const res = await prescribe({ lines: [line('Paracetamol 500 mg', { drugId: drug(1), quantity: 10, instructions: 'after food' })] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      encounterId, patientId: ramesh, doctorId: seedId('a0000000', 3), source: 'typed', status: 'confirmed',
      confirmedBy: 'dev-doctor', acknowledgedAlerts: [], lines: [{ drugId: drug(1), drugText: 'Paracetamol 500 mg', days: 5, quantity: 10 }],
    });
  });

  it('409 rx_alerts on the penicillin group until acknowledged; info alerts need nothing', async () => {
    const lines = [line('Amoxicillin', { drugId: drug(3) }), line('Tramadol', { drugId: drug(10) })];
    const res = await prescribe({ lines });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; alerts: Alert[] };
    expect(body.error).toBe('rx_alerts');
    expect(body.alerts).toMatchObject([
      { id: 'allergy:0', severity: 'warning', kind: 'allergy', lineIndex: 0 },
      { id: 'schedule:1', severity: 'info', kind: 'schedule', lineIndex: 1 },
    ]);
    const ok = await prescribe({ lines, acknowledgedAlerts: ['allergy:0'] });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ acknowledgedAlerts: ['allergy:0'] });
  });

  it('warns on a duplicate line and a long course; blocks on a severe allergy even when acknowledged', async () => {
    const dup = await prescribe({ lines: [line('ORS'), line('ors', { days: 120 })] });
    expect(((await dup.json()) as { alerts: Alert[] }).alerts.map((a) => a.id)).toEqual(['duplicate:1', 'dose:1']);
    const allergy = await app.request(`/staff/patients/${ramesh}/allergies`, json({ substance: 'NSAID', severity: 'severe' }), doctor);
    expect(allergy.status).toBe(201);
    const blocked = await prescribe({ lines: [line('Ibuprofen 400 mg')], acknowledgedAlerts: ['allergy:0'] });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: 'rx_alerts', alerts: [{ id: 'allergy:0', severity: 'block' }] });
  });

  it('shows in the encounter and on the timeline', async () => {
    const detail = (await (await app.request(`/staff/encounters/${encounterId}`, {}, doctor)).json()) as { prescriptions: unknown[] };
    expect(detail.prescriptions).toHaveLength(2);
    const timeline = await app.request(`/staff/patients/${ramesh}/timeline?kind=prescription`, {}, doctor);
    expect(((await timeline.json()) as { items: { title: string }[] }).items.map((i) => i.title)).toEqual(['Prescription', 'Prescription']);
  });

  it('422 for no lines, 31 lines, a bad line or an unknown drug; 403 for a nurse; 404 for no encounter', async () => {
    expect((await prescribe({ lines: [] })).status).toBe(422);
    expect((await prescribe({ lines: Array.from({ length: 31 }, (_, i) => line(`Drug ${i}`)) })).status).toBe(422);
    expect((await prescribe({ lines: [line('ORS', { days: 0 })] })).status).toBe(422);
    expect((await prescribe({ lines: [line('Nothing', { drugId: drug(999) })] })).status).toBe(422);
    expect((await prescribe({ lines: [line('ORS')] }, encounterId, nurse)).status).toBe(403);
    expect((await prescribe({ lines: [line('ORS')] }, seedId('e0000000', 999))).status).toBe(404);
  });
});

describe('POST /staff/prescriptions/check', () => {
  const check = (body: unknown, who = doctor) => app.request('/staff/prescriptions/check', json(body), who);

  it('returns the alerts without saving anything', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM prescriptions')).rows[0]?.n;
    const res = await check({ patientId: ramesh, lines: [line('Amoxicillin', { drugId: drug(3) }), line('Morphine', { drugId: drug(12) })] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { alerts: Alert[] }).alerts.map((a) => `${a.id} ${a.severity}`)).toEqual(['allergy:0 warning', 'schedule:1 info']);
    expect((await db.query('SELECT count(*)::int AS n FROM prescriptions')).rows[0]?.n).toBe(before);
    expect(await (await check({ patientId: seedId('9a710000', 3), lines: [line('Paracetamol')] })).json()).toEqual({ alerts: [] });
  });

  it('422 for a bad body or unknown drug; 404 for no patient; 403 for a nurse', async () => {
    expect((await check({ patientId: ramesh, lines: [] })).status).toBe(422);
    expect((await check({ patientId: ramesh, lines: [line('X', { drugId: drug(999) })] })).status).toBe(422);
    expect((await check({ patientId: seedId('9a710000', 999), lines: [line('Paracetamol')] })).status).toBe(404);
    expect((await check({ patientId: ramesh, lines: [line('Paracetamol')] }, nurse)).status).toBe(403);
  });
});
