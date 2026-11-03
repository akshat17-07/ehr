import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { requireEnv } from '../../config/env.js';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { LINK_SECONDS, type SignGetUrl } from '../../files/signed-url.js';
import type { Mailer } from '../../mail/mailer.js';
import { AppError } from '../../middleware/errors.js';
import { getHospital } from '../reference/hospital.js';
import { tokenHash } from './record-requests.js';

// No-login share links (api-list.md #274, #275): a one-time code goes to the link's email, then a 10-minute signed link.

export const OTP_SENDS_PER_HOUR = 5;
export const OTP_MAX_WRONG = 5;
const HOUR_MS = 3_600_000;

interface ShareLink {
  id: string;
  version: number;
  patientId: string;
  s3Key: string;
  email: string;
  otpHash: string | null;
  otpExpiresAt: Date | null;
  otpSends: string[];
  otpWrongTries: number;
}

const otpHash = (token: string, code: string) => createHash('sha256').update(`${token}:${code}`).digest('hex');

/** a@b.com -> a***@b.com */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

/** 404 for a malformed, unknown or voided token (same body), 410 once the link has expired. */
async function findLink(db: Queryable, token: string, now: Date): Promise<ShareLink> {
  const missing = () => new AppError(404, 'not_found', 'no such link');
  if (token.length < 16 || token.length > 200) throw missing();
  const { rows } = await db.query('SELECT * FROM share_links WHERE token_hash = $1 AND voided_at IS NULL', [tokenHash(token)]);
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) throw missing();
  if ((r.expires_at as Date).getTime() <= now.getTime()) throw new AppError(410, 'link_expired', 'this link has expired');
  return {
    id: String(r.id),
    version: Number(r.version),
    patientId: String(r.patient_id),
    s3Key: String(r.s3_key),
    email: String(r.email),
    otpHash: (r.otp_hash as string | null) ?? null,
    otpExpiresAt: (r.otp_expires_at as Date | null) ?? null,
    otpSends: JSON.parse(String(r.otp_sends ?? '[]')) as string[],
    otpWrongTries: Number(r.otp_wrong_tries),
  };
}

/** #274: emails a new 6-digit code (valid 10 minutes). 429 too_many_codes after 5 sends in a rolling hour. */
export async function sendShareOtp(
  db: Queryable,
  token: string,
  mailer: Mailer,
  now = new Date(),
): Promise<{ patientId: string; linkId: string; sentTo: string; expiresInSec: number }> {
  const link = await findLink(db, token, now);
  const recent = link.otpSends.filter((t) => new Date(t).getTime() > now.getTime() - HOUR_MS);
  if (recent.length >= OTP_SENDS_PER_HOUR) throw new AppError(429, 'too_many_codes', 'too many codes asked for; try again later');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await updateRecord(db, 'share_links', {
    id: link.id,
    version: link.version,
    by: 'anonymous',
    set: {
      otp_hash: otpHash(token, code),
      otp_expires_at: new Date(now.getTime() + LINK_SECONDS * 1000),
      otp_wrong_tries: 0,
      otp_sends: JSON.stringify([...recent, now.toISOString()]),
    },
  });
  const hospital = await getHospital(db);
  await mailer.send({
    to: link.email,
    subject: `${hospital.name}: your one-time code`,
    text: [
      `Your one-time code is ${code}. It works for 10 minutes.`,
      `आपका एक बार इस्तेमाल होने वाला कोड ${code} है। यह 10 मिनट तक चलेगा।`,
      'If you did not ask for this, ignore this email. / अगर आपने यह नहीं मांगा, तो इस ईमेल को अनदेखा करें।',
    ].join('\n\n'),
  });
  return { patientId: link.patientId, linkId: link.id, sentTo: maskEmail(link.email), expiresInSec: LINK_SECONDS };
}

/** #275: 422 otp_expired / otp_wrong, 429 too_many_tries (locked until a new code is sent). A right code works once. */
export async function verifyShareOtp(
  db: Queryable,
  token: string,
  parseCode: () => string,
  signUrl: SignGetUrl,
  now = new Date(),
): Promise<{ patientId: string; linkId: string; url: string; expiresAt: string }> {
  const link = await findLink(db, token, now);
  const code = parseCode();
  // The attempt is counted BEFORE the code is compared, in one statement, so parallel guesses can't beat the limit.
  // Raw update without a history row, like the counters (db/counters.ts): this is attempt bookkeeping, not an edit.
  const { rows } = await db.query(
    `UPDATE share_links SET otp_wrong_tries = otp_wrong_tries + 1, version = version + 1, updated_at = now(), updated_by = 'anonymous'
     WHERE id = $1 AND voided_at IS NULL AND otp_wrong_tries < $2 AND otp_hash IS NOT NULL AND otp_expires_at > $3
     RETURNING otp_hash, otp_wrong_tries`,
    [link.id, OTP_MAX_WRONG, now],
  );
  const reserved = rows[0] as { otp_hash: string; otp_wrong_tries: number } | undefined;
  if (!reserved) {
    const again = await db.query('SELECT otp_wrong_tries FROM share_links WHERE id = $1', [link.id]);
    if (Number(again.rows[0]?.otp_wrong_tries) >= OTP_MAX_WRONG) throw new AppError(429, 'too_many_tries', 'too many wrong codes; ask for a new code');
    throw new AppError(422, 'otp_expired', 'the code has expired; ask for a new code');
  }
  const given = Buffer.from(otpHash(token, code), 'hex');
  const right = Buffer.from(reserved.otp_hash, 'hex');
  if (given.length !== right.length || !timingSafeEqual(given, right)) {
    if (Number(reserved.otp_wrong_tries) >= OTP_MAX_WRONG) throw new AppError(429, 'too_many_tries', 'too many wrong codes; ask for a new code');
    throw new AppError(422, 'otp_wrong', 'the code is wrong');
  }
  // One use: only the request that still sees this hash clears it; a parallel second try gets otp_expired.
  const used = await db.query(
    `UPDATE share_links SET otp_hash = NULL, otp_expires_at = NULL, otp_wrong_tries = 0, version = version + 1, updated_at = now(), updated_by = 'anonymous'
     WHERE id = $1 AND otp_hash = $2 RETURNING id`,
    [link.id, reserved.otp_hash],
  );
  if (!used.rows[0]) throw new AppError(422, 'otp_expired', 'the code has expired; ask for a new code');
  const url = await signUrl(requireEnv('EXPORTS_BUCKET'), link.s3Key, LINK_SECONDS);
  return { patientId: link.patientId, linkId: link.id, url, expiresAt: new Date(now.getTime() + LINK_SECONDS * 1000).toISOString() };
}
