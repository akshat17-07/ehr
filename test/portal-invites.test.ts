import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { migrations } from '../src/db/migrations.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import type { Mail } from '../src/mail/mailer.js';

// #409-#412: the hospital invites a patient to the portal by an email or phone link; the patient accepts after sign-in.

const db = await openLocalDb();
await seedDev(db);
const sent: Mail[] = [];
let mailDown = false;
const app = createApp({
  db: async () => db,
  mailer: {
    send: vi.fn(async (mail: Mail) => {
      if (mailDown) throw new Error('mail down');
      sent.push(mail);
    }),
  },
});

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const asPatient = (sub: string, email?: string) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, ...(email && { email }) } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const reception = asStaff('dev-reception', ['staff']);
const doctor = asStaff('dev-doctor', ['doctor']);

const call = (method: string, path: string, who: unknown, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, who as never);
// Fresh patients 1..16 (the dev seed has only a few).
const ids: string[] = [''];
for (let n = 1; n <= 16; n++) {
  const res = await call('POST', '/staff/patients', reception, { name: `Invitee ${n}`, sex: 'F', ageYears: 30 });
  ids.push(((await res.json()) as { id: string }).id);
}
const patientN = (n: number) => ids[n] ?? seedId('9a710000', n);
const setContact = (n: number, email: string | null, mobile: string | null) =>
  db.query('UPDATE patients SET email = $2, mobile = $3, labels = $4 WHERE id = $1', [patientN(n), email, mobile, '[]']);
const tokenOf = (link: string) => link.slice(link.lastIndexOf('/') + 1);
type Created = { invite: { id: string; status: string; sentTo: string; channel: string; patientId: string }; link: string };
const invite = async (n: number, body: unknown, who: unknown = admin) => {
  const res = await call('POST', `/staff/patients/${patientN(n)}/portal-invites`, who, body);
  return { res, body: (await res.json()) as Created };
};

describe('POST /staff/patients/:id/portal-invites', () => {
  it('emails an English + Hindi invite with the link; defaults to the email on file', async () => {
    await setContact(1, 'ramesh@example.com', '9876500001');
    sent.length = 0;
    const { res, body } = await invite(1, { channel: 'email' });
    expect(res.status).toBe(201);
    expect(body.invite).toMatchObject({ channel: 'email', status: 'pending', sentTo: 'r***@example.com', patientId: patientN(1) });
    expect(body.link).toMatch(/\/invite\/[A-Za-z0-9_-]{40,}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ramesh@example.com');
    expect(sent[0]!.text).toContain(body.link);
    expect(sent[0]!.text).toMatch(/पोर्टल/);
    expect(JSON.stringify(body)).not.toMatch(/token_hash|tokenHash/);
  });

  it('phone: returns the link, sends nothing, normalises the number', async () => {
    await setContact(2, null, '9876500002');
    sent.length = 0;
    const defaulted = await invite(2, { channel: 'phone' });
    expect(defaulted.res.status).toBe(201);
    expect(defaulted.body.invite.sentTo).toBe('******0002');
    const given = await invite(2, { channel: 'phone', to: '+91 98765-00003' });
    expect(given.body.invite.sentTo).toBe('******0003');
    expect(given.body.link).toContain('/invite/');
    expect(sent).toHaveLength(0);
  });

  it('422 with no contact to use or a bad one', async () => {
    await setContact(3, null, null);
    expect((await invite(3, { channel: 'email' })).res.status).toBe(422);
    expect((await invite(3, { channel: 'phone' })).res.status).toBe(422);
    expect((await invite(3, { channel: 'phone', to: '12345' })).res.status).toBe(422);
    expect((await invite(3, { channel: 'email', to: 'nope' })).res.status).toBe(422);
    expect((await invite(3, { channel: 'sms' })).res.status).toBe(422);
  });

  it('a failed email saves nothing', async () => {
    await setContact(4, 'a@example.com', null);
    mailDown = true;
    expect((await invite(4, { channel: 'email' })).res.status).toBe(500);
    mailDown = false;
    expect((await db.query('SELECT 1 FROM portal_invites WHERE patient_id = $1', [patientN(4)])).rows).toHaveLength(0);
  });

  it('revokes earlier pending invites when a new one is made; at most 5 a day', async () => {
    await setContact(5, 'k@example.com', null);
    const first = await invite(5, { channel: 'email' });
    const second = await invite(5, { channel: 'email' });
    const list = (await (await call('GET', `/staff/patients/${patientN(5)}/portal-invites`, admin)).json()) as { id: string; status: string; revokedReason?: string }[];
    expect(list.map((i) => [i.id, i.status])).toEqual([[second.body.invite.id, 'pending'], [first.body.invite.id, 'revoked']]);
    expect(list[1]!.revokedReason).toBe('replaced');
    for (let i = 0; i < 3; i++) expect((await invite(5, { channel: 'email' })).res.status).toBe(201);
    const sixth = await call('POST', `/staff/patients/${patientN(5)}/portal-invites`, admin, { channel: 'email' });
    expect(sixth.status).toBe(409);
    expect(await sixth.json()).toMatchObject({ error: 'too_many_invites' });
  });

  it('403 without portal.invite and on a restricted patient; 404 unknown; merged points at the kept patient', async () => {
    await setContact(6, 'x@example.com', null);
    expect((await invite(6, { channel: 'email' }, doctor)).res.status).toBe(403);
    await db.query("UPDATE patients SET labels = '[\"hiv\"]' WHERE id = $1", [patientN(6)]);
    const restricted = await invite(6, { channel: 'email' }, reception);
    expect(restricted.res.status).toBe(403);
    expect(restricted.body).toMatchObject({ error: 'sensitive_record' });
    await db.query("UPDATE patients SET labels = '[]' WHERE id = $1", [patientN(6)]);
    expect((await call('POST', `/staff/patients/${seedId('9a710000', 999)}/portal-invites`, admin, { channel: 'email' })).status).toBe(404);
    await db.query('UPDATE patients SET merged_into = $2 WHERE id = $1', [patientN(6), patientN(7)]);
    const merged = await invite(6, { channel: 'email' });
    expect(merged.res.status).toBe(409);
    expect(merged.body).toMatchObject({ error: 'merged', patientId: patientN(7) });
    await db.query('UPDATE patients SET merged_into = NULL WHERE id = $1', [patientN(6)]);
  });

  it('reception can invite', async () => {
    await setContact(8, 'rec@example.com', null);
    expect((await invite(8, { channel: 'email' }, reception)).res.status).toBe(201);
  });
});

describe('GET list and POST revoke', () => {
  it('lists masked, newest first, never the token', async () => {
    const res = await call('GET', `/staff/patients/${patientN(1)}/portal-invites`, admin);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/token/i);
    expect(JSON.parse(text)[0]).toMatchObject({ channel: 'email', sentTo: 'r***@example.com', status: 'pending' });
    expect((await call('GET', `/staff/patients/${patientN(1)}/portal-invites`, doctor)).status).toBe(403);
  });

  it('revokes a pending invite once; later states are 409; 422 without a reason; 404 unknown', async () => {
    await setContact(9, 'v@example.com', null);
    const made = await invite(9, { channel: 'email' });
    const path = `/staff/portal-invites/${made.body.invite.id}/revoke`;
    expect((await call('POST', path, admin, {})).status).toBe(422);
    expect((await call('POST', path, doctor, { reason: 'x' })).status).toBe(403);
    const ok = await call('POST', path, admin, { reason: 'wrong person' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'revoked', revokedReason: 'wrong person' });
    expect((await call('POST', path, admin, { reason: 'again' })).status).toBe(409);
    expect((await call('POST', `/staff/portal-invites/${patientN(1)}/revoke`, admin, { reason: 'x' })).status).toBe(404);
    // The old link is dead.
    expect((await call('POST', '/patient/invites/accept', asPatient('pt-v'), { token: tokenOf(made.body.link) })).status).toBe(410);
  });

  it('shows an unaccepted invite past its expiry as expired, and cannot revoke it', async () => {
    await setContact(10, 'e@example.com', null);
    const made = await invite(10, { channel: 'email' });
    await db.query("UPDATE portal_invites SET expires_at = '2020-01-01T00:00:00Z' WHERE id = $1", [made.body.invite.id]);
    const list = (await (await call('GET', `/staff/patients/${patientN(10)}/portal-invites`, admin)).json()) as { status: string }[];
    expect(list[0]!.status).toBe('expired');
    expect((await call('POST', `/staff/portal-invites/${made.body.invite.id}/revoke`, admin, { reason: 'x' })).status).toBe(409);
    expect((await call('POST', '/patient/invites/accept', asPatient('pt-e'), { token: tokenOf(made.body.link) })).status).toBe(410);
  });
});

describe('POST /patient/invites/accept', () => {
  const accept = (who: unknown, token: string) => call('POST', '/patient/invites/accept', who, { token });

  it('links a new sign-in, then /patient/me-style routes work; the same invite again is a 200', async () => {
    await setContact(11, 'new@example.com', null);
    const made = await invite(11, { channel: 'email' });
    const who = asPatient('pt-new', 'new@example.com');
    expect((await call('GET', '/patient/profiles', who)).status).toBe(403);
    const res = await accept(who, tokenOf(made.body.link));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profiles: [{ patientId: patientN(11), relation: 'self' }] });
    const profiles = await call('GET', '/patient/profiles', who);
    expect(profiles.status).toBe(200);
    expect(await profiles.json()).toMatchObject([{ patientId: patientN(11) }]);
    expect((await accept(who, tokenOf(made.body.link))).status).toBe(200);
    expect((await db.query('SELECT 1 FROM patient_accounts WHERE cognito_sub = $1', ['pt-new'])).rows).toHaveLength(1);
    const listed = (await (await call('GET', `/staff/patients/${patientN(11)}/portal-invites`, admin)).json()) as { status: string; acceptedAt?: string }[];
    expect(listed[0]).toMatchObject({ status: 'accepted' });
    expect(listed[0]!.acceptedAt).toBeTruthy();
    // Another sign-in cannot use the used invite, and the patient already has an account.
    expect((await accept(asPatient('pt-other'), tokenOf(made.body.link))).status).toBe(410);
  });

  it('unknown, revoked and malformed tokens are the same 410', async () => {
    const bad = await accept(asPatient('pt-x'), 'a'.repeat(43));
    expect(bad.status).toBe(410);
    expect(await bad.json()).toMatchObject({ error: 'invite_invalid' });
    expect((await accept(asPatient('pt-x'), 'short')).status).toBe(410);
    expect((await call('POST', '/patient/invites/accept', asPatient('pt-x'), {})).status).toBe(422);
  });

  it('409 already_linked when the sign-in has another patient; 409 patient_has_account when the patient has another sign-in', async () => {
    await setContact(12, 'l@example.com', null);
    await setContact(13, 'm@example.com', null);
    const one = await invite(12, { channel: 'email' });
    const two = await invite(13, { channel: 'email' });
    expect((await accept(asPatient('pt-multi'), tokenOf(one.body.link))).status).toBe(200);
    const linked = await accept(asPatient('pt-multi'), tokenOf(two.body.link));
    expect(linked.status).toBe(409);
    expect(await linked.json()).toMatchObject({ error: 'already_linked' });
    const taken = await invite(12, { channel: 'email' });
    const has = await accept(asPatient('pt-someone-else'), tokenOf(taken.body.link));
    expect(has.status).toBe(409);
    expect(await has.json()).toMatchObject({ error: 'patient_has_account' });
  });

  it('an email claim must match an email invite; no claim means the link alone is the proof', async () => {
    await setContact(14, 'right@example.com', null);
    const made = await invite(14, { channel: 'email' });
    expect((await accept(asPatient('pt-claim', 'wrong@example.com'), tokenOf(made.body.link))).status).toBe(410);
    expect((await accept(asPatient('pt-claim', 'RIGHT@example.com'), tokenOf(made.body.link))).status).toBe(200);
    await setContact(15, null, '9876500015');
    const phone = await invite(15, { channel: 'phone' });
    expect((await accept(asPatient('pt-phone', 'anything@else.com'), tokenOf(phone.body.link))).status).toBe(200);
  });
});

describe('migration 0103 on a database made before it', () => {
  it('adds portal.invite to admin, head doctor and staff only, once', async () => {
    const old = await openLocalDb();
    await seedDev(old);
    await old.query(`UPDATE type_permissions SET permissions = replace(replace(permissions, ',"portal.invite"', ''), '"portal.invite",', '') WHERE type IN ('admin', 'head_doctor', 'staff')`);
    const has = async (type: string) => String((await old.query('SELECT permissions FROM type_permissions WHERE type = $1', [type])).rows[0]!.permissions).includes('portal.invite');
    expect(await has('staff')).toBe(false);
    const update = migrations.find((m) => m.id === '0103_portal_invites')!.statements({ apiRoleArn: 'x' }).find((q) => q.startsWith('UPDATE type_permissions'))!;
    await old.query(update);
    await old.query(update);
    for (const type of ['admin', 'head_doctor', 'staff']) expect(await has(type), type).toBe(true);
    expect(await has('doctor')).toBe(false);
    expect(String((await old.query("SELECT permissions FROM type_permissions WHERE type = 'staff'")).rows[0]!.permissions).match(/portal\.invite/g)).toHaveLength(1);
  });
});
