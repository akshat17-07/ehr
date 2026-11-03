import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { wardRelation } from '../src/modules/portal/portal-access.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

// Patient-pool tokens (no groups); a staff token has groups and, in AWS, the staff pool's issuer.
function asPatient(sub: string, iss?: string) {
  const claims = { sub, email: `${sub}@x.in`, ...(iss && { iss }) };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}
function asStaff(sub: string, groups: string[], iss?: string) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]`, ...(iss && { iss }) };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}

const ramesh = seedId('9a710000', 1); // account A: self
const sita = seedId('9a710000', 2); // A's wife (A is her guardian, portal access)
const irfan = seedId('9a710000', 3); // A is guardian but without portal access
const kavita = seedId('9a710000', 4); // account B
const rahul = seedId('9a710000', 5); // A's son (A is his guardian, portal access)
const doctorId = seedId('a0000000', 3);
const surgeonId = seedId('a0000000', 4);
const med = seedId('de000000', 1);
const partner = seedId('9a000000', 1);

const A = asPatient('pt-ramesh');
const B = asPatient('pt-kavita');

const link = (sub: string, patientId: string, voided = false) =>
  db.query(
    `INSERT INTO patient_accounts (id, status, created_at, created_by, updated_by, patient_id, cognito_sub, voided_at)
     VALUES ($1, 'active', '2026-01-01T00:00:00Z', 'system', 'system', $2, $3, $4)`,
    [randomUUID(), patientId, sub, voided ? new Date('2026-02-01T00:00:00Z') : null],
  );
const guardian = (wardId: string, guardianId: string, relation: string, portal: boolean) =>
  db.query(
    `INSERT INTO guardians (id, status, created_at, created_by, updated_by, patient_id, guardian_patient_id, name, relation, portal_access)
     VALUES ($1, 'active', '2026-01-01T00:00:00Z', 'system', 'system', $2, $3, 'Ramesh Kumar Sharma', $4, $5)`,
    [randomUUID(), wardId, guardianId, relation, portal],
  );

const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string, who: never) => app.request(path, {}, who);
const patch = (q: string, body: unknown, who: never) => app.request(`/patient/profile${q}`, { method: 'PATCH', ...json(body) }, who);
const versionOf = async (id: string) => Number((await db.query('SELECT version FROM patients WHERE id = $1', [id])).rows[0]?.version);

beforeAll(async () => {
  await link('pt-ramesh', ramesh);
  await link('pt-kavita', kavita);
  await link('pt-voided', irfan, true);
  await guardian(sita, ramesh, 'Husband', true);
  await guardian(rahul, ramesh, 'father', true);
  await guardian(irfan, ramesh, 'brother', false);
  // The seed's appointments are today: take them out so "next" doesn't depend on the clock.
  await db.query("UPDATE appointments SET status = 'cancelled'");
});

describe('wardRelation', () => {
  it('turns the guardian\'s relation round; unknown text is other', () => {
    expect(['Mother', 'father', 'Son', 'daughter', 'wife', 'husband', 'uncle', 'chacha'].map(wardRelation))
      .toEqual(['child', 'child', 'parent', 'parent', 'spouse', 'spouse', 'other', 'other']);
  });
});

describe('GET /patient/profiles', () => {
  it('lists self first, then family with portal access, by name', async () => {
    const res = await get('/patient/profiles', A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { patientId: ramesh, uhid: 'U24000001', name: 'Ramesh Kumar Sharma', relation: 'self' },
      { patientId: rahul, uhid: 'U26000005', name: 'Rahul Verma', relation: 'child' },
      { patientId: sita, uhid: 'U24000002', name: 'Sita Sharma', relation: 'spouse' },
    ]);
  });

  it('patient B sees only themself, not A or A\'s family', async () => {
    expect(await (await get('/patient/profiles', B)).json()).toEqual([
      { patientId: kavita, uhid: 'U25000004', name: 'Kavita Patel', relation: 'self' },
    ]);
  });

  it('403 no_patient_record for an unlinked sign-in, a voided link, and a staff token', async () => {
    for (const who of [asPatient('pt-nobody'), asPatient('pt-voided'), asStaff('dev-doctor', ['doctor'])]) {
      const res = await get('/patient/profiles', who);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'no_patient_record' });
    }
  });

  it('401 without a token', async () => {
    expect((await app.request('/patient/profiles')).status).toBe(401);
  });

  it('a merged patient\'s account resolves to the kept patient', async () => {
    const merged = randomUUID();
    await db.query(
      `INSERT INTO patients (id, status, created_by, updated_by, uhid, name, name_search, sex, labels, allergies, merged_into)
       VALUES ($1, 'active', 'system', 'system', 'U26999999', 'Old Kavita', 'old kavita', 'F', '[]', '[]', $2)`,
      [merged, kavita],
    );
    await link('pt-kavita-old', merged);
    expect(await (await get('/patient/profiles', asPatient('pt-kavita-old'))).json()).toEqual([
      { patientId: kavita, uhid: 'U25000004', name: 'Kavita Patel', relation: 'self' },
    ]);
  });
});

describe('staff tokens in AWS (pool check)', () => {
  afterEach(() => {
    env.PATIENT_POOL_ID = undefined;
  });
  it('a staff-pool token is refused on every portal route', async () => {
    env.PATIENT_POOL_ID = 'ap-south-1_patient';
    const staff = asStaff('dev-admin', ['admin'], 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_staff');
    for (const res of [
      await get('/patient/profiles', staff),
      await get('/patient/home', staff),
      await patch('', { version: 1, email: 'x@y.in' }, staff),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'wrong_pool' });
    }
    const ok = asPatient('pt-ramesh', 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_patient');
    expect((await get('/patient/profiles', ok)).status).toBe(200);
  });
});

describe('PATCH /patient/profile', () => {
  const address = { line1: '7 Arera Colony', city: 'Bhopal', district: 'Bhopal', state: 'Madhya Pradesh', pincode: '462016' };

  it('updates own contact details, keeps the old version, audits, and shows no staff-only fields', async () => {
    const version = await versionOf(ramesh);
    const res = await patch('', { version, mobile: '+91 98260 11111', email: 'ramesh@x.in', address }, A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: ramesh, version: version + 1, name: 'Ramesh Kumar Sharma', mobile: '9826011111', email: 'ramesh@x.in', address });
    for (const key of ['labels', 'createdBy', 'updatedBy', 'emergencyNote', 'broughtBy', 'referrerId', 'inactive', 'lastActivityAt']) {
      expect(body).not.toHaveProperty(key);
    }
    const history = await db.query('SELECT version, reason, replaced_by FROM patients_versions WHERE record_id = $1 AND version = $2', [ramesh, version]);
    expect(history.rows).toEqual([{ version, reason: 'patient portal', replaced_by: 'pt-ramesh' }]);
    const audit = await db.query(
      "SELECT action, record_type, record_id, user_id FROM audit_events WHERE patient_id = $1 AND reason = 'patient portal' ORDER BY seq DESC LIMIT 1",
      [ramesh],
    );
    expect(audit.rows).toEqual([{ action: 'update', record_type: 'patient', record_id: ramesh, user_id: 'pt-ramesh' }]);
  });

  it('null clears a field', async () => {
    const res = await patch('', { version: await versionOf(ramesh), address: null }, A);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('address');
  });

  it('updates a linked family member', async () => {
    const res = await patch(`?patientId=${rahul}`, { version: await versionOf(rahul), email: 'rahul@x.in' }, A);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: rahul, email: 'rahul@x.in' });
  });

  it('409 on a stale version', async () => {
    const res = await patch('', { version: 1, email: 'late@x.in' }, A);
    expect(res.status).toBe(409);
  });

  it('422 for name / DOB / sex, a bad mobile, a bad email or PIN', async () => {
    const version = await versionOf(ramesh);
    for (const body of [
      { version, name: 'Someone Else' },
      { version, dob: '1970-01-01' },
      { version, sex: 'F' },
      { version, mobile: '12345' },
      { version, email: 'not-an-email' },
      { version, address: { ...address, pincode: '012345' } },
      { email: 'x@y.in' },
    ]) {
      expect((await patch('', body, A)).status).toBe(422);
    }
  });

  it('403 forbidden for patient B, a guardian without portal access, a made-up ID and junk, all alike', async () => {
    const before = await versionOf(kavita);
    const bodies: unknown[] = [];
    for (const id of [kavita, irfan, randomUUID(), 'junk']) {
      const res = await patch(`?patientId=${id}`, { version: 1, email: 'hijack@x.in' }, A);
      expect(res.status).toBe(403);
      bodies.push(await res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ error: 'forbidden' });
    expect(await versionOf(kavita)).toBe(before);
    // ... and B can't reach A.
    expect((await patch(`?patientId=${ramesh}`, { version: await versionOf(ramesh), email: 'hijack@x.in' }, B)).status).toBe(403);
    const denied = await db.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE user_id = 'pt-ramesh' AND action = 'denied' AND patient_id IS NULL",
    );
    expect(denied.rows[0]?.n).toBeGreaterThanOrEqual(4);
  });

  it('403 no_patient_record for a staff token without a patient link', async () => {
    const res = await patch('', { version: 1, email: 'x@y.in' }, asStaff('dev-reception', ['staff']));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'no_patient_record' });
  });
});

describe('GET /patient/home', () => {
  const future = (days: number) => new Date(Date.now() + days * 86_400_000);
  const surgeryId = randomUUID();

  beforeAll(async () => {
    const appt = (patientId: string, at: Date, status = 'booked') =>
      db.query(
        `INSERT INTO appointments (id, status, created_at, created_by, updated_by, patient_id, doctor_id, department_id, at, ends_at, duration_min, note)
         VALUES ($1, $2, '2026-01-01T00:00:00Z', 'dev-reception', 'dev-reception', $3, $4, $5, $6, $7, 10, 'staff only: difficult patient')`,
        [randomUUID(), status, patientId, doctorId, med, at, new Date(at.getTime() + 600_000)],
      );
    await appt(ramesh, future(-2)); // past
    await appt(ramesh, future(3), 'cancelled');
    await appt(ramesh, future(5));
    await appt(ramesh, future(9));
    await appt(kavita, future(1));

    const surgery = (id: string, patientId: string, at: Date, status = 'scheduled') =>
      db.query(
        `INSERT INTO surgeries (id, status, created_at, created_by, updated_by, patient_id, procedure, surgeon_id, team_ids, scheduled_at, venue,
           partner_hospital_id, charges_paise, consent_document_ids, instructions, checklist, op_note)
         VALUES ($1, $2, '2026-01-01T00:00:00Z', 'dev-surgeon', 'dev-surgeon', $3, 'Lap cholecystectomy', $4, '[]', $5, 'partner', $6, 4500000, '[]',
           'Nil by mouth after 10 pm', '{"secret":true}', '{"secret":true}')`,
        [id, status, patientId, surgeonId, at, partner],
      );
    await surgery(randomUUID(), ramesh, future(4), 'cancelled');
    await surgery(surgeryId, ramesh, future(12));
    await surgery(randomUUID(), kavita, future(2));
    await db.query(
      `INSERT INTO venue_payments (id, status, created_at, created_by, updated_by, surgery_id, partner_hospital_id, amount_paise, paid_on, mode)
       VALUES ($1, 'active', '2026-01-01T00:00:00Z', 'dev-admin', 'dev-admin', $2, $3, 3100000, '2026-01-02', 'neft')`,
      [randomUUID(), surgeryId, partner],
    );

    const bill = (patientId: string, status: string, total: number, paid: number) =>
      db.query(
        `INSERT INTO bills (id, status, created_at, created_by, updated_by, patient_id, series, lines, subtotal_paise, gst_paise, total_paise, paid_paise)
         VALUES ($1, $2, '2026-01-01T00:00:00Z', 'dev-billing', 'dev-billing', $3, 'tax_invoice', '[]', $4, 0, $4, $5)`,
        [randomUUID(), status, patientId, total, paid],
      );
    await bill(ramesh, 'final', 50000, 0);
    await bill(ramesh, 'part_paid', 30000, 10000);
    await bill(ramesh, 'paid', 20000, 20000);
    await bill(ramesh, 'draft', 99900, 0);
    await bill(ramesh, 'void', 77700, 0);
    await bill(kavita, 'final', 12300, 0);
  });

  it('gives the next booked appointment, the next scheduled surgery, what is due, and 0 unread', async () => {
    const res = await get('/patient/home', A);
    expect(res.status).toBe(200);
    const home = (await res.json()) as { nextAppointment: Record<string, unknown>; nextSurgery: Record<string, unknown>; duePaise: number; unreadCount: number };
    expect(home.duePaise).toBe(70000);
    expect(home.unreadCount).toBe(0);
    expect(home.nextAppointment).toMatchObject({ status: 'booked', patientId: ramesh, doctorName: 'Dr Neha Gupta', durationMin: 10 });
    expect(Date.parse(String(home.nextAppointment.at))).toBeGreaterThan(future(4).getTime());
    expect(Date.parse(String(home.nextAppointment.at))).toBeLessThan(future(6).getTime());
    expect(home.nextSurgery).toMatchObject({ id: surgeryId, procedure: 'Lap cholecystectomy', venue: 'partner', surgeonName: 'Dr Vikram Singh',
      chargesPaise: 4500000, instructions: 'Nil by mouth after 10 pm' });
    expect(typeof home.nextSurgery.hospitalName).toBe('string');
  });

  it('never shows venue payments or staff-only fields', async () => {
    const text = await (await get('/patient/home', A)).text();
    for (const leak of ['3100000', 'venuePaid', 'amountPaise', 'secret', 'checklist', 'opNote', 'teamIds', 'note', 'createdBy', 'updatedBy', 'dev-']) {
      expect(text).not.toContain(leak);
    }
  });

  it('a linked family member\'s home, and an empty one', async () => {
    const res = await get(`/patient/home?patientId=${sita}`, A);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ duePaise: 0, unreadCount: 0 });
  });

  it('patient B gets their own home; neither can open the other\'s', async () => {
    const own = (await (await get('/patient/home', B)).json()) as { duePaise: number };
    expect(own.duePaise).toBe(12300);
    for (const [path, who] of [[`/patient/home?patientId=${kavita}`, A], [`/patient/home?patientId=${ramesh}`, B], [`/patient/home?patientId=${irfan}`, A]] as const) {
      const res = await get(path, who);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'forbidden' });
    }
  });

  it('403 no_patient_record for a staff token', async () => {
    const res = await get('/patient/home', asStaff('dev-billing', ['staff']));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'no_patient_record' });
  });
});
