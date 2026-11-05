import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

// Task 711: name, UHID and other own fields on the portal me, the staff bills, the GP me and the agent patients.

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const asPatient = (sub: string) => ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, email: `${sub}@x.in` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const agent = asStaff('dev-insurance', ['insurance']);
const gp = asStaff('dev-gp', ['gp']);
const call = async (path: string, who: never, init: RequestInit = {}) => {
  const res = await app.request(path, init, who);
  return { status: res.status, body: (await res.json()) as any };
};
const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const ramesh = seedId('9a710000', 1);
const hiv = seedId('9a710000', 2);
const irfan = seedId('9a710000', 3);
const kavita = seedId('9a710000', 4);
const nameOf = async (id: string) =>
  (await db.query('SELECT name, uhid, mobile FROM patients WHERE id = $1', [id])).rows[0] as { name: string; uhid: string; mobile: string | null };
await db.query(`UPDATE patients SET labels = '["hiv"]' WHERE id = $1`, [hiv]);

describe('#711 GET /patient/me', () => {
  it('adds the caller own linked patient only; a family account sees its own, never the ward or another account', async () => {
    const at = '2026-01-01T00:00:00Z';
    await db.query(
      `INSERT INTO patient_accounts (id, status, created_at, created_by, updated_by, patient_id, cognito_sub)
       VALUES ($1, 'active', $2, 's', 's', $3, 'pt-bb5-a'), ($4, 'active', $2, 's', 's', $5, 'pt-bb5-b')`,
      [randomUUID(), at, ramesh, randomUUID(), kavita],
    );
    await db.query(
      `INSERT INTO guardians (id, status, created_at, created_by, updated_by, patient_id, guardian_patient_id, name, relation, portal_access)
       VALUES ($1, 'active', $2, 's', 's', $3, $4, 'G', 'Father', true)`,
      [randomUUID(), at, irfan, ramesh],
    );
    const a = await call('/patient/me', asPatient('pt-bb5-a'));
    const own = await nameOf(ramesh);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ sub: 'pt-bb5-a', name: own.name, uhid: own.uhid, mobile: own.mobile });
    const ward = await nameOf(irfan);
    expect(JSON.stringify(a.body)).not.toContain(ward.uhid);
    const b = await call('/patient/me', asPatient('pt-bb5-b'));
    const other = await nameOf(kavita);
    expect(b.body).toMatchObject({ name: other.name, uhid: other.uhid });
    expect(JSON.stringify(b.body)).not.toContain(own.uhid);
    const unlinked = await call('/patient/me', asPatient('pt-bb5-none'));
    expect(unlinked.status).toBe(200);
    expect(unlinked.body).toMatchObject({ name: null, uhid: null, mobile: null });
  });
});

describe('#711 staff bills', () => {
  it('list and detail carry patientName and uhid; the list hides them for a patient the caller may not open', async () => {
    const ok = await call('/staff/bills', doctor, post({ patientId: irfan, lines: [{ text: 'Dressing', qty: 1, unitPaise: 15000 }] }));
    expect(ok.status).toBe(201);
    const sensitive = await call('/staff/bills', asStaff('dev-admin', ['admin']), post({ patientId: hiv, lines: [{ text: 'Dressing', qty: 1, unitPaise: 15000 }] }));
    expect(sensitive.status).toBe(201);
    const who = await nameOf(irfan);
    const detail = await call(`/staff/bills/${ok.body.id}`, doctor);
    expect(detail.body).toMatchObject({ patientName: who.name, uhid: who.uhid });
    const list = await call(`/staff/bills?patientId=${irfan}`, doctor);
    expect(list.body.items[0]).toMatchObject({ patientName: who.name, uhid: who.uhid });
    // the sensitive patient's bill: the detail stays refused, the list shows no name or UHID
    const hidden = await nameOf(hiv);
    expect((await call(`/staff/bills/${sensitive.body.id}`, doctor)).status).toBe(403);
    const l = await call(`/staff/bills?patientId=${hiv}`, doctor);
    expect(l.body.items[0]).toMatchObject({ patientName: null, uhid: null });
    expect(JSON.stringify(l.body)).not.toContain(hidden.uhid);
    expect(JSON.stringify(l.body)).not.toContain(hidden.name);
  });
});

describe('#711 GET /other/gp/me', () => {
  it('name, registrationNo and practice; null when unknown', async () => {
    const before = await call('/other/gp/me', gp);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ name: 'Dr Anil Dubey', registrationNo: null, practice: null });
    const id = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-gp'")).rows[0]?.id);
    await db.query("UPDATE users SET council_reg_no = 'MP-1234' WHERE id = $1", [id]);
    await db.query(
      `INSERT INTO referrers (id, status, created_by, updated_by, name, name_search, clinic, user_id, pseudo)
       VALUES ($1, 'active', 's', 's', 'Dr Anil Dubey', 'dr anil dubey', 'Dubey Clinic, Rewa', $2, false)`,
      [randomUUID(), id],
    );
    expect((await call('/other/gp/me', gp)).body).toMatchObject({ name: 'Dr Anil Dubey', registrationNo: 'MP-1234', practice: 'Dubey Clinic, Rewa' });
  });
});

describe('#711 GET /other/insurance/patients linkEndsOn', () => {
  it('the link end date or null; an ended link lists nothing', async () => {
    const agentId = String((await db.query("SELECT id FROM users WHERE cognito_sub = 'dev-insurance'")).rows[0]?.id);
    const link = (patientId: string, from: string, to: string | null) =>
      db.query(
        `INSERT INTO agent_links (id, status, created_at, created_by, updated_by, patient_id, agent_user_id, from_date, to_date)
         VALUES ($1, 'active', '2026-01-01T00:00:00Z', 't', 't', $2, $3, $4, $5)`,
        [randomUUID(), patientId, agentId, from, to],
      );
    await link(ramesh, '2020-01-01', '2099-12-31');
    await link(kavita, '2020-01-01', null);
    await link(irfan, '2020-01-01', '2021-01-01'); // ended
    const { status, body } = await call('/other/insurance/patients?limit=100', agent);
    expect(status).toBe(200);
    const byId = new Map<string, any>(body.items.map((i: any) => [i.patientId, i]));
    expect(byId.get(ramesh).linkEndsOn).toBe('2099-12-31');
    expect(byId.get(kavita).linkEndsOn).toBeNull();
    expect(byId.has(irfan)).toBe(false);
    expect(JSON.stringify(body)).not.toContain((await nameOf(irfan)).uhid);
  });
});
