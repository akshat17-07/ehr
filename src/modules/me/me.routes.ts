import { Hono } from 'hono';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { portalProfiles } from '../portal/portal-access.js';

// Returns who the caller is, as seen by the API. Mounted under both /api and /portal.
export const meRoutes = new Hono<AuthEnv>().get('/', (c) => c.json(c.get('user') ?? null));

// #711: GET /patient/me adds the caller's OWN linked patient (name, uhid, mobile); never a family member's, and
// null for all three when the sign-in is not linked to a patient.
export const patientMeRoutes = new Hono<AuthEnv>().get('/', async (c) => {
  const user = userOf(c);
  const db = await dbOf(c);
  const links = await db.query(
    `SELECT p.id, p.merged_into FROM patient_accounts a JOIN patients p ON p.id = a.patient_id
     WHERE a.cognito_sub = $1 AND a.voided_at IS NULL`,
    [user.sub],
  );
  let own: { name: string; uhid: string; mobile: string | null } | null = null;
  if (links.rows.length === 1) {
    const selfId = (await portalProfiles(db, user.sub))[0]?.patientId;
    const { rows } = await db.query('SELECT name, uhid, mobile FROM patients WHERE id = $1', [selfId]);
    if (rows[0]) own = { name: String(rows[0].name), uhid: String(rows[0].uhid), mobile: rows[0].mobile == null ? null : String(rows[0].mobile) };
  }
  return c.json({ ...user, name: own?.name ?? null, uhid: own?.uhid ?? null, mobile: own?.mobile ?? null });
});

// #711: GET /other/gp/me adds the GP's own name, registrationNo (council registration) and practice (the clinic of
// the GP's referrer record); null when unknown.
export const gpMeRoutes = new Hono<AuthEnv>().get('/', async (c) => {
  const user = userOf(c);
  const db = await dbOf(c);
  const u = (await db.query('SELECT id, name, council_reg_no FROM users WHERE cognito_sub = $1', [user.sub])).rows[0];
  let clinic: unknown = null;
  let refReg: unknown = null;
  if (u) {
    const r = (await db.query(
      'SELECT clinic, reg_no FROM referrers WHERE user_id = $1 AND voided_at IS NULL AND merged_into IS NULL ORDER BY created_at, id LIMIT 1',
      [u.id],
    )).rows[0];
    clinic = r?.clinic ?? null;
    refReg = r?.reg_no ?? null;
  }
  const text = (v: unknown) => (v == null || v === '' ? null : String(v));
  return c.json({ ...user, name: text(u?.name), registrationNo: text(u?.council_reg_no) ?? text(refReg), practice: text(clinic) });
});
