import { randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import type { Mailer } from '../../mail/mailer.js';
import { AppError } from '../../middleware/errors.js';
import { indiaDate } from '../../time/india.js';
import { UUID } from '../users/users.js';
import { getPatient } from '../patients/patients.js';
import { tokenHash } from '../records/record-requests.js';
import { maskEmail } from '../records/share.js';
import { getHospital } from '../reference/hospital.js';
import { portalProfiles, type PortalProfile } from './portal-access.js';

// Portal invites (api-list.md #409-#412): the hospital invites a patient to sign up for the portal by an email or
// phone link. The patient record (with the mobile number) exists whether or not the patient ever signs up; a patient
// who never accepts simply keeps no portal access and nothing else about them changes. To see their data in the
// portal they must sign up through the link. Only the sha256 of the token is stored; the link is returned once.
// No sign-in provider specifics here: the accepting sub goes into patient_accounts.cognito_sub (historic name).

export const INVITE_CHANNELS = ['email', 'phone'] as const;
export type InviteChannel = (typeof INVITE_CHANNELS)[number];
export const INVITE_DAYS = 7;
export const INVITES_PER_DAY = 5;

export interface PortalInvite {
  id: string;
  patientId: string;
  channel: InviteChannel;
  /** Masked: a***@x.com or ******1234. */
  sentTo: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  acceptedAt?: string;
  revokedReason?: string;
  createdAt: string;
  createdBy: string;
}

const maskPhone = (phone: string) => `${'*'.repeat(Math.max(phone.length - 4, 0))}${phone.slice(-4)}`;

function toInvite(r: Record<string, unknown>, now: Date): PortalInvite {
  const expiresAt = r.expires_at as Date;
  const status = String(r.status) as 'pending' | 'accepted' | 'revoked';
  const channel = String(r.channel) as InviteChannel;
  const sentTo = String(r.sent_to);
  return {
    id: String(r.id),
    patientId: String(r.patient_id),
    channel,
    sentTo: channel === 'email' ? maskEmail(sentTo) : maskPhone(sentTo),
    status: status === 'pending' && expiresAt.getTime() <= now.getTime() ? 'expired' : status,
    expiresAt: expiresAt.toISOString(),
    ...(r.accepted_at != null && { acceptedAt: (r.accepted_at as Date).toISOString() }),
    ...(r.revoked_reason != null && { revokedReason: String(r.revoked_reason) }),
    createdAt: (r.created_at as Date).toISOString(),
    createdBy: String(r.creator ?? r.created_by),
  };
}

const SELECT = 'SELECT i.*, u.id AS creator FROM portal_invites i LEFT JOIN users u ON u.cognito_sub = i.created_by';

/** Where the patient opens the invite: PORTAL_URL (required in production) + /invite/<token>. */
function inviteLink(token: string): string {
  const base = env.PORTAL_URL ?? (env.NODE_ENV === 'production' ? undefined : 'http://localhost:5173');
  if (!base) throw new Error('PORTAL_URL is not set');
  return `${base.replace(/\/+$/, '')}/invite/${token}`;
}

/**
 * #409. `to` is already normalised by the route (a mobile in the stored 10-digit format). 422 when there is nothing to
 * send to, 409 merged (details.patientId is the kept patient), 409 too_many_invites after 5 in an India day.
 * Earlier pending invites of the patient are revoked ('replaced'). The email goes out inside the transaction, so a
 * failed send saves nothing.
 */
export async function createPortalInvite(
  db: Queryable,
  patientId: string,
  input: { channel: InviteChannel; to?: string },
  by: string,
  mailer: Mailer,
  now = new Date(),
): Promise<{ invite: PortalInvite; link: string }> {
  const patient = await getPatient(db, patientId, now);
  const merged = (await db.query('SELECT merged_into FROM patients WHERE id = $1', [patient.id])).rows[0]?.merged_into;
  if (merged != null) {
    throw new AppError(409, 'merged', 'this patient was merged into another; invite that one', { patientId: String(merged) });
  }
  const to = input.to ?? (input.channel === 'email' ? patient.email : patient.mobile);
  if (!to) throw new AppError(422, 'invalid_input', `the patient has no ${input.channel === 'email' ? 'email' : 'mobile number'} on file; give "to"`);

  const hospital = await getHospital(db);
  const token = randomBytes(32).toString('base64url');
  const link = inviteLink(token);
  const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000);
  const today = indiaDate(now);

  const row = await withTransaction(db, async (tx) => {
    const earlier = (await tx.query(`${SELECT} WHERE i.patient_id = $1 ORDER BY i.created_at, i.id`, [patient.id])).rows as Record<string, unknown>[];
    if (earlier.filter((r) => indiaDate(r.created_at as Date) === today).length >= INVITES_PER_DAY) {
      throw new AppError(409, 'too_many_invites', `at most ${INVITES_PER_DAY} invites per patient per day`);
    }
    for (const r of earlier.filter((e) => e.status === 'pending')) {
      await updateRecord(tx, 'portal_invites', { id: String(r.id), version: Number(r.version), by, set: { status: 'revoked', revoked_reason: 'replaced' }, reason: 'replaced by a new invite' });
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO portal_invites (id, status, created_by, updated_by, patient_id, channel, sent_to, token_hash, expires_at)
       VALUES ($1, 'pending', $2, $2, $3, $4, $5, $6, $7)`,
      [id, by, patient.id, input.channel, to, tokenHash(token), expiresAt],
    );
    if (input.channel === 'email') {
      // No medical details: only who invites and where to sign up.
      await mailer.send({
        to,
        subject: `${hospital.name}: sign up for the patient portal`,
        text: [
          `${hospital.name} invites you to the patient portal, where you can see your visits, bills and records. Open this link to sign up (valid ${INVITE_DAYS} days):`,
          link,
          `${hospital.name} आपको पेशेंट पोर्टल पर आमंत्रित करता है, जहाँ आप अपनी विज़िट, बिल और रिकॉर्ड देख सकते हैं। साइन अप करने के लिए यह लिंक खोलें (${INVITE_DAYS} दिन तक मान्य):`,
          link,
          'If you did not expect this, ignore this email. / अगर आपको इसकी उम्मीद नहीं थी, तो इस ईमेल को अनदेखा करें।',
        ].join('\n\n'),
      });
    }
    return (await tx.query(`${SELECT} WHERE i.id = $1`, [id])).rows[0] as Record<string, unknown>;
  });
  return { invite: toInvite(row, now), link };
}

/** #410: the patient's invites, newest first. Never the token or its hash. */
export async function listPortalInvites(db: Queryable, patientId: string, now = new Date()): Promise<PortalInvite[]> {
  const patient = await getPatient(db, patientId, now);
  const { rows } = await db.query(`${SELECT} WHERE i.patient_id = $1 ORDER BY i.created_at DESC, i.id DESC`, [patient.id]);
  return rows.map((r) => toInvite(r as Record<string, unknown>, now));
}

export async function getPortalInvite(db: Queryable, id: string, now = new Date()): Promise<PortalInvite> {
  const { rows } = UUID.test(id) ? await db.query(`${SELECT} WHERE i.id = $1`, [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found', 'no such invite');
  return toInvite(rows[0] as Record<string, unknown>, now);
}

/** #411: pending (and not yet expired) only; 409 not_pending otherwise. */
export async function revokePortalInvite(db: Queryable, id: string, reason: string, by: string, now = new Date()): Promise<PortalInvite> {
  const invite = await getPortalInvite(db, id, now);
  if (invite.status !== 'pending') throw new AppError(409, 'not_pending', `this invite is ${invite.status}`);
  const version = Number((await db.query('SELECT version FROM portal_invites WHERE id = $1', [id])).rows[0]?.version);
  await updateRecord(db, 'portal_invites', { id, version, by, set: { status: 'revoked', revoked_reason: reason }, reason });
  return getPortalInvite(db, id, now);
}

const invalid = () => new AppError(410, 'invite_invalid', 'this invite is not valid');

/**
 * #412: the signed-in patient-pool sub accepts an invite and gets linked to the patient. Unknown, revoked, expired or
 * used tokens are one 410 invite_invalid. `claimEmail` is the sign-in's email, '' when the token has none: when the
 * invite went by email and there is a claim it must match; otherwise the secret link is the only proof (the sign-in
 * token carries no phone claim today, so a phone invite is proved by the link alone).
 * Known gap: wrong tokens are not rate-limited per sub (tokens are 256-bit random, so guessing is not feasible);
 * a staff route to void a wrong patient_accounts link does not exist yet.
 */
export async function acceptPortalInvite(
  db: Queryable,
  token: string,
  sub: string,
  claimEmail: string,
  now = new Date(),
): Promise<PortalProfile[]> {
  if (token.length < 16 || token.length > 200) throw invalid();
  const { rows } = await db.query('SELECT * FROM portal_invites WHERE token_hash = $1 AND voided_at IS NULL', [tokenHash(token)]);
  const inv = rows[0] as Record<string, unknown> | undefined;
  if (!inv) throw invalid();
  const patientRow = (await db.query('SELECT id, merged_into FROM patients WHERE id = $1', [inv.patient_id])).rows[0];
  if (!patientRow) throw invalid();
  const patientId = String(patientRow.merged_into ?? patientRow.id);

  const mine = (await db.query('SELECT patient_id FROM patient_accounts WHERE cognito_sub = $1 AND voided_at IS NULL', [sub])).rows;
  const linkedHere = mine.length > 0 && (await Promise.all(mine.map(async (m) => String((await db.query('SELECT merged_into FROM patients WHERE id = $1', [m.patient_id])).rows[0]?.merged_into ?? m.patient_id)))).includes(patientId);
  // Same sign-in, same patient, same invite again: nothing to do.
  if (linkedHere && inv.status === 'accepted' && inv.accepted_sub === sub) return portalProfiles(db, sub);

  if (inv.status !== 'pending' || (inv.expires_at as Date).getTime() <= now.getTime()) throw invalid();
  if (inv.channel === 'email' && claimEmail && claimEmail.trim().toLowerCase() !== String(inv.sent_to).trim().toLowerCase()) throw invalid();

  if (linkedHere) {
    await updateRecord(db, 'portal_invites', { id: String(inv.id), version: Number(inv.version), by: sub, set: { status: 'accepted', accepted_at: now, accepted_sub: sub } });
    return portalProfiles(db, sub);
  }
  if (mine.length > 0) throw new AppError(409, 'already_linked', 'this sign-in is already linked to a patient record');
  const others = await db.query(
    `SELECT a.id FROM patient_accounts a JOIN patients p ON p.id = a.patient_id
     WHERE a.voided_at IS NULL AND COALESCE(p.merged_into, p.id) = $1`,
    [patientId],
  );
  if (others.rows.length > 0) throw new AppError(409, 'patient_has_account', 'this patient already has a portal account');

  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO patient_accounts (id, status, created_by, updated_by, patient_id, cognito_sub) VALUES ($1, 'active', $2, $2, $3, $4)`,
      [randomUUID(), sub, patientId, sub],
    );
    await updateRecord(tx, 'portal_invites', { id: String(inv.id), version: Number(inv.version), by: sub, set: { status: 'accepted', accepted_at: now, accepted_sub: sub } });
  });
  return portalProfiles(db, sub);
}
