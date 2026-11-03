import type { Context } from 'hono';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { auditDetails } from '../../middleware/audit.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { AppError } from '../../middleware/errors.js';

// Who a patient-portal sign-in may act for (api-list.md §8). Every /patient/* route resolves its patient here.
// The sign-in (a patient-pool Cognito sub) is linked to one patient in patient_accounts (0099); a voided link, or
// none, is 403 no_patient_record. The account may also act for family members whose guardian it is: guardians rows
// with guardian_patient_id = self and portal_access = true. Merged patients count as the patient they were merged into.
// Any other patientId is a plain 403 forbidden that never says whether the ID exists; the audit middleware logs it.

export const PROFILE_RELATIONS = ['self', 'child', 'parent', 'spouse', 'other'] as const;
export type ProfileRelation = (typeof PROFILE_RELATIONS)[number];

export interface PortalProfile {
  patientId: string;
  uhid: string;
  name: string;
  relation: ProfileRelation;
}

const noPatientRecord = () => new AppError(403, 'no_patient_record', 'this sign-in is not linked to a patient record');
const notYours = () => new AppError(403, 'forbidden', 'not a patient this account may see');

// guardians.relation is free text naming the guardian (from the ward's side): turn it round to name the ward.
const AS_PARENT = ['mother', 'father', 'parent', 'mom', 'mum', 'dad', 'stepmother', 'stepfather', 'step-mother', 'step-father'];
const AS_CHILD = ['son', 'daughter', 'child', 'stepson', 'stepdaughter', 'step-son', 'step-daughter'];
const AS_SPOUSE = ['husband', 'wife', 'spouse'];

/** The ward's relation to the account holder, from the guardian's relation text. Unknown text is 'other'. */
export function wardRelation(guardianRelation: string): ProfileRelation {
  const r = guardianRelation.trim().toLowerCase();
  if (AS_PARENT.includes(r)) return 'child';
  if (AS_CHILD.includes(r)) return 'parent';
  if (AS_SPOUSE.includes(r)) return 'spouse';
  return 'other';
}

/** The patient a merged record now lives in (one step: a merge always points at the kept patient). */
const liveId = (r: Record<string, unknown>) => String(r.merged_into ?? r.id);

/** The account's own patient and the family members it may act for, self first, then by name. */
export async function portalProfiles(db: Queryable, sub: string): Promise<PortalProfile[]> {
  const links = await db.query(
    `SELECT p.id, p.merged_into FROM patient_accounts a JOIN patients p ON p.id = a.patient_id
     WHERE a.cognito_sub = $1 AND a.voided_at IS NULL`,
    [sub],
  );
  // More than one live link would be a setup mistake: refuse rather than guess.
  if (links.rows.length !== 1) throw noPatientRecord();
  const selfId = liveId(links.rows[0] as Record<string, unknown>);

  const self = await db.query('SELECT id, uhid, name FROM patients WHERE id = $1', [selfId]);
  if (!self.rows[0]) throw noPatientRecord();
  const profiles: PortalProfile[] = [
    { patientId: selfId, uhid: String(self.rows[0].uhid), name: String(self.rows[0].name), relation: 'self' },
  ];

  const wards = await db.query(
    `SELECT g.relation, p.id, p.merged_into FROM guardians g JOIN patients p ON p.id = g.patient_id
     WHERE g.guardian_patient_id = $1 AND g.portal_access = true AND g.voided_at IS NULL ORDER BY g.created_at, g.id`,
    [selfId],
  );
  const relations = new Map<string, ProfileRelation>();
  for (const w of wards.rows as Record<string, unknown>[]) {
    const id = liveId(w);
    if (id !== selfId && !relations.has(id)) relations.set(id, wardRelation(String(w.relation)));
  }
  if (relations.size > 0) {
    const ids = [...relations.keys()];
    const { rows } = await db.query(
      `SELECT id, uhid, name FROM patients WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY name, id`,
      ids,
    );
    for (const r of rows) {
      profiles.push({ patientId: String(r.id), uhid: String(r.uhid), name: String(r.name), relation: relations.get(String(r.id)) ?? 'other' });
    }
  }
  return profiles;
}

/**
 * The patient a /patient/* request is about: `patientId` if the signed-in account may act for it, else self.
 * 403 no_patient_record when the sign-in has no patient; 403 forbidden for any other ID (existing or not).
 * Sets the audit row's patient.
 */
export async function resolvePortalPatient(c: Context<AuthEnv>, patientId?: string): Promise<PortalProfile> {
  const profiles = await portalProfiles(await dbOf(c), userOf(c).sub);
  const self = profiles[0] as PortalProfile;
  const wanted = patientId === undefined || patientId === '' ? self.patientId : patientId;
  const profile = z.uuid().safeParse(wanted).success ? profiles.find((p) => p.patientId === wanted) : undefined;
  if (!profile) throw notYours();
  auditDetails(c, { patientId: profile.patientId });
  return profile;
}
