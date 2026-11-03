import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import type { Mail } from '../src/mail/mailer.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';
import { tokenHash } from '../src/modules/records/record-requests.js';

const db = await openLocalDb();
await seedDev(db);
env.EXPORTS_BUCKET = 'exports-test';
const sent: Mail[] = [];
const app = createApp({
  db: async () => db,
  mailer: { send: async (mail) => void sent.push(mail) },
  signUrl: async (bucket, key, seconds) => `https://s3.test/${bucket}/${key}?get=${seconds}`,
});

const ramesh = seedId('9a710000', 1);
const post = (token: string, action: 'otp' | 'verify', body?: unknown) =>
  app.request(`/other/share/${token}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });

/** A share link straight in the table with a known token. */
async function makeLink(opts: { expiresInMs?: number; voided?: boolean; email?: string } = {}) {
  const token = `tok-${randomUUID()}${randomUUID()}`;
  const id = randomUUID();
  const now = new Date();
  await db.query(
    `INSERT INTO share_links (id, status, created_at, updated_at, created_by, updated_by, voided_at, record_request_id, patient_id, token_hash, s3_key, email, expires_at)
     VALUES ($1, 'active', $2, $2, 'test', 'test', $3, $4, $5, $6, $7, $8, $9)`,
    [id, now, opts.voided ? now : null, randomUUID(), ramesh, tokenHash(token), `record-copies/${id}.html`, opts.email ?? 'ramesh@example.in', new Date(now.getTime() + (opts.expiresInMs ?? 86_400_000))],
  );
  return { token, id, key: `record-copies/${id}.html` };
}
const row = async (id: string) => (await db.query('SELECT * FROM share_links WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
/** Asks for a code and returns the 6 digits from the email. */
async function askCode(token: string) {
  const before = sent.length;
  const res = await post(token, 'otp');
  expect(res.status).toBe(200);
  expect(sent.length).toBe(before + 1);
  return /\b(\d{6})\b/.exec(sent[sent.length - 1]!.text)![1]!;
}
const wrongOf = (code: string) => (code === '000000' ? '000001' : '000000');

describe('POST /other/share/:token/otp', () => {
  it('emails a 6-digit code without a login and masks the address; the code is not in the response', async () => {
    const { token, id } = await makeLink();
    const before = sent.length;
    const res = await post(token, 'otp');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ sentTo: 'r***@example.in', expiresInSec: 600 });
    expect(sent.length).toBe(before + 1);
    const mail = sent[sent.length - 1]!;
    expect(mail.to).toBe('ramesh@example.in');
    const code = /\b(\d{6})\b/.exec(mail.text)![1]!;
    expect(text).not.toContain(code);
    expect(mail.text).toContain('10 minutes');
    const r = await row(id);
    expect(r.otp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.otp_hash).not.toContain(code);
    expect(r.otp_wrong_tries).toBe(0);
    const audit = await db.query("SELECT user_id, patient_id FROM audit_events WHERE record_type = 'share_link' AND record_id = $1", [id]);
    expect(audit.rows[0]).toMatchObject({ user_id: 'anonymous', patient_id: ramesh });
  });

  it('404 with the same body for a malformed or unknown token, or a voided link', async () => {
    const bodies = [
      await (await post('short', 'otp')).json(),
      await (await post('x'.repeat(201), 'otp')).json(),
      await (await post(`unknown-${randomUUID()}`, 'otp')).json(),
    ];
    const voided = await makeLink({ voided: true });
    const res = await post(voided.token, 'otp');
    expect(res.status).toBe(404);
    bodies.push(await res.json());
    for (const b of bodies) expect(b).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ error: 'not_found' });
    expect((await post('short', 'otp')).status).toBe(404);
  });

  it('410 for an expired link, with no mail', async () => {
    const { token } = await makeLink({ expiresInMs: -1000 });
    const before = sent.length;
    const res = await post(token, 'otp');
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: 'link_expired' });
    expect(sent.length).toBe(before);
  });

  it('429 on the 6th send in an hour with no mail; sends older than an hour do not count', async () => {
    const { token, id } = await makeLink();
    for (let i = 0; i < 5; i++) await askCode(token);
    const before = sent.length;
    const res = await post(token, 'otp');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'too_many_codes' });
    expect(sent.length).toBe(before);

    // Push every send to 61 minutes ago: the next one is allowed and the old entries are pruned.
    const old = JSON.parse(String((await row(id)).otp_sends)) as string[];
    const aged = old.map(() => new Date(Date.now() - 61 * 60_000).toISOString());
    await db.query('UPDATE share_links SET otp_sends = $1 WHERE id = $2', [JSON.stringify(aged), id]);
    await askCode(token);
    expect(JSON.parse(String((await row(id)).otp_sends))).toHaveLength(1);
  });
});

describe('POST /other/share/:token/verify', () => {
  it('right code: a 10-minute signed link for the stored file, used once', async () => {
    const { token, id, key } = await makeLink();
    const code = await askCode(token);
    const res = await post(token, 'verify', { otp: code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(body.url).toBe(`https://s3.test/exports-test/${key}?get=600`);
    const left = new Date(body.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(590_000);
    expect(left).toBeLessThanOrEqual(600_000);
    expect((await row(id)).otp_hash).toBeNull();
    const again = await post(token, 'verify', { otp: code });
    expect(again.status).toBe(422);
    expect(await again.json()).toMatchObject({ error: 'otp_expired' });
    const audit = await db.query("SELECT action FROM audit_events WHERE record_type = 'share_link' AND record_id = $1 AND action = 'download'", [id]);
    expect(audit.rows).toHaveLength(1);
  });

  it('wrong code: 422 otp_wrong and the tries go up; no code asked yet is otp_expired', async () => {
    const fresh = await makeLink();
    const none = await post(fresh.token, 'verify', { otp: '123456' });
    expect(none.status).toBe(422);
    expect(await none.json()).toMatchObject({ error: 'otp_expired' });

    const { token, id } = await makeLink();
    const code = await askCode(token);
    const res = await post(token, 'verify', { otp: wrongOf(code) });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'otp_wrong' });
    expect((await row(id)).otp_wrong_tries).toBe(1);
    expect((await post(token, 'verify', { otp: code })).status).toBe(200);
  });

  it('5 wrong codes lock the link (429, even for the right code) until a new code resets the tries', async () => {
    const { token, id } = await makeLink();
    const code = await askCode(token);
    for (let i = 1; i <= 4; i++) expect((await post(token, 'verify', { otp: wrongOf(code) })).status).toBe(422);
    const fifth = await post(token, 'verify', { otp: wrongOf(code) });
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toMatchObject({ error: 'too_many_tries' });
    expect((await row(id)).otp_wrong_tries).toBe(5);
    expect((await post(token, 'verify', { otp: code })).status).toBe(429);

    const fresh = await askCode(token);
    expect((await row(id)).otp_wrong_tries).toBe(0);
    expect((await post(token, 'verify', { otp: fresh })).status).toBe(200);
  });

  it('a code older than 10 minutes is 422 otp_expired', async () => {
    const { token, id } = await makeLink();
    const code = await askCode(token);
    await db.query('UPDATE share_links SET otp_expires_at = $1 WHERE id = $2', [new Date(Date.now() - 1000), id]);
    const res = await post(token, 'verify', { otp: code });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'otp_expired' });
  });

  it('422 for a bad body; the link is checked first (404 / 410)', async () => {
    const { token } = await makeLink();
    for (const body of [{ otp: '12345' }, { otp: '1234567' }, { otp: 'abcdef' }, { otp: 123456 }, {}, { otp: '123456', extra: 1 }]) {
      expect((await post(token, 'verify', body)).status).toBe(422);
    }
    expect((await post(token, 'verify')).status).toBe(422);
    expect((await post('short', 'verify', { otp: 'bad' })).status).toBe(404);
    const expired = await makeLink({ expiresInMs: -1000 });
    expect((await post(expired.token, 'verify', { otp: 'bad' })).status).toBe(410);
  });

  it('parallel wrong guesses cannot beat the 5-try limit, and the right code is then locked out', async () => {
    const { token } = await makeLink();
    const code = await askCode(token);
    const results = await Promise.all(Array.from({ length: 10 }, () => post(token, 'verify', { otp: wrongOf(code) })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 422).length).toBeLessThanOrEqual(4);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(6);
    expect(statuses.every((s) => s === 422 || s === 429)).toBe(true);
    expect((await post(token, 'verify', { otp: code })).status).toBe(429);
  });

  it('the right code works once even when sent twice in parallel', async () => {
    const { token } = await makeLink();
    const code = await askCode(token);
    const statuses = (await Promise.all([post(token, 'verify', { otp: code }), post(token, 'verify', { otp: code })])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 422]);
  });
});

describe('parallel code requests and the audit log', () => {
  it('6 parallel /otp calls send at most 5 codes in the hour', async () => {
    const { token, id } = await makeLink();
    const before = sent.length;
    const statuses = (await Promise.all(Array.from({ length: 6 }, () => post(token, 'otp')))).map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(5);
    expect(statuses.every((s) => [200, 409, 429].includes(s))).toBe(true);
    expect(sent.length - before).toBe(statuses.filter((s) => s === 200).length);
    expect(JSON.parse(String((await row(id)).otp_sends)).length).toBe(sent.length - before);
  });

  it('never writes the raw token to the audit log, on failures or successes', async () => {
    const unknown = `unknown-${randomUUID()}${randomUUID()}`;
    await post(unknown, 'otp');
    const { token } = await makeLink();
    const code = await askCode(token);
    await post(token, 'verify', { otp: wrongOf(code) });
    await post(token, 'verify', { otp: 'bad' });
    await post(token, 'verify', { otp: code });
    for (const t of [unknown, token]) {
      const hits = await db.query('SELECT 1 FROM audit_events WHERE record_id LIKE $1', [`%${t}%`]);
      expect(hits.rows).toHaveLength(0);
    }
    const generic = await db.query("SELECT 1 FROM audit_events WHERE record_id = 'POST /other/share/:token/otp'");
    expect(generic.rows.length).toBeGreaterThan(0);
  });
});
