import { randomUUID } from 'node:crypto';
import type { Queryable } from '../../db/migrate.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { isUsernameTaken, type StaffAccounts } from '../../identity/staff-accounts.js';
import { assertAdminRemains } from '../permissions/admin-rules.js';
import { bundlesNamed } from '../../permissions/bundles.js';
import { pageRows, type Page, type PageQuery } from '../../db/page.js';
import { AppError } from '../../middleware/errors.js';
import { STAFF_TYPES, type StaffType } from '../../permissions/defaults.js';

// Staff and partner accounts (api-list.md User). Sign-in is in Cognito (linked by cognito_sub); this table holds
// what the hospital knows about them. Bundles are kept with the custom permissions (user_permissions, by sub).

export interface User {
  id: string;
  version: number;
  cognitoSub: string;
  name: string;
  email: string;
  mobile: string;
  type: StaffType;
  departmentIds: string[];
  councilName?: string;
  councilRegNo?: string;
  /** YYYY-MM-DD */
  regValidTill?: string;
  pharmacistRegNo?: string;
  bundles: string[];
  active: boolean;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The date as text, so no time zone can move it a day.
const SELECT = 'SELECT users.*, reg_valid_till::text AS reg_valid_till_text FROM users';

const opt = (v: unknown) => (v == null ? undefined : String(v));

function toUser(r: Record<string, unknown>, bundles: string[]): User {
  const user: User = {
    id: String(r.id),
    version: Number(r.version),
    cognitoSub: String(r.cognito_sub),
    name: String(r.name),
    email: String(r.email),
    mobile: String(r.mobile),
    type: r.type as StaffType,
    departmentIds: JSON.parse(String(r.department_ids)) as string[],
    councilName: opt(r.council_name),
    councilRegNo: opt(r.council_reg_no),
    regValidTill: opt(r.reg_valid_till_text),
    pharmacistRegNo: opt(r.pharmacist_reg_no),
    bundles,
    active: r.active === true,
  };
  for (const key of Object.keys(user) as (keyof User)[]) if (user[key] === undefined) delete user[key];
  return user;
}

/** Bundles of these users (by Cognito sub), in one query. */
async function bundlesOf(db: Queryable, subs: string[]): Promise<Map<string, string[]>> {
  if (subs.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT user_id, bundles FROM user_permissions WHERE user_id IN (${subs.map((_, i) => `$${i + 1}`).join(', ')})`,
    subs,
  );
  return new Map(rows.map((r) => [String(r.user_id), r.bundles == null ? [] : (JSON.parse(String(r.bundles)) as string[])]));
}

export interface UserFilter {
  type?: StaffType;
  departmentId?: string;
  active?: boolean;
  /** Part of the name or email. */
  q?: string;
}

/** #153: users by name (A to Z). */
export async function listUsers(db: Queryable, filter: UserFilter & PageQuery): Promise<Page<User>> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (n: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };
  if (filter.type) add((n) => `type = ${n}`, filter.type);
  // department_ids is a JSON array of ids, e.g. ["…","…"]; an id is a UUID, so the quoted id can't match by accident.
  if (filter.departmentId) add((n) => `department_ids LIKE ${n}`, `%"${filter.departmentId}"%`);
  if (filter.active !== undefined) add((n) => `active = ${n}`, filter.active);
  if (filter.q) add((n) => `(lower(name) LIKE ${n} OR lower(email) LIKE ${n})`, `%${filter.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);

  const page = await pageRows(db, { select: SELECT, where, params, orderBy: ['name', 'id'], direction: 'asc' }, filter, (r) => r);
  const bundles = await bundlesOf(db, page.items.map((r) => String(r.cognito_sub)));
  return { ...page, items: page.items.map((r) => toUser(r, bundles.get(String(r.cognito_sub)) ?? [])) };
}

/** #155: one user; 404 if there is none. */
export async function getUser(db: Queryable, id: string): Promise<User> {
  const { rows } = UUID.test(id) ? await db.query(`${SELECT} WHERE id = $1`, [id]) : { rows: [] };
  const row = rows[0];
  if (!row) throw new AppError(404, 'not_found');
  const bundles = await bundlesOf(db, [String(row.cognito_sub)]);
  return toUser(row, bundles.get(String(row.cognito_sub)) ?? []);
}

export const isStaffType = (v: string): v is StaffType => (STAFF_TYPES as readonly string[]).includes(v);

export interface NewUser {
  name: string;
  email: string;
  mobile: string;
  /** Not head_doctor: a doctor is promoted with #161. */
  type: Exclude<StaffType, 'head_doctor'>;
  departmentIds: string[];
  councilName?: string;
  councilRegNo?: string;
  regValidTill?: string;
  pharmacistRegNo?: string;
  bundles: string[];
}

const invalid = (message: string) => new AppError(422, 'invalid_input', message);
const emailTaken = () => new AppError(409, 'email_taken', 'a user with this email already exists');

/** Departments that exist and are active, else 422. */
export async function checkDepartments(db: Queryable, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const { rows } = await db.query(
    `SELECT id FROM departments WHERE active AND id IN (${unique.map((_, i) => `$${i + 1}`).join(', ')})`,
    unique,
  );
  const found = new Set(rows.map((r) => String(r.id)));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) throw invalid(`unknown or inactive department: ${missing.join(', ')}`);
}

/** Bundles that exist, else 422. */
export async function checkBundles(db: Queryable, names: string[]): Promise<void> {
  const found = new Set((await bundlesNamed(db, names)).map((b) => b.name));
  const missing = names.filter((n) => !found.has(n));
  if (missing.length > 0) throw invalid(`unknown bundle: ${missing.join(', ')}`);
}

/**
 * #154: makes the Cognito account (Cognito emails the invite), puts it in its type's group, then saves the user.
 * If anything after the invite fails, the new account is disabled, so no one can sign in to a half-made user.
 */
export async function createUser(db: Queryable, accounts: StaffAccounts, input: NewUser, by: string): Promise<User> {
  const email = input.email.toLowerCase();
  await checkDepartments(db, input.departmentIds);
  const bundles = [...new Set(input.bundles)].sort();
  await checkBundles(db, bundles);
  if ((await db.query('SELECT 1 FROM users WHERE email = $1', [email])).rows.length > 0) throw emailTaken();

  let sub: string;
  try {
    sub = await accounts.invite({ email, name: input.name });
  } catch (error) {
    if (isUsernameTaken(error)) throw emailTaken();
    throw error;
  }

  const id = randomUUID();
  try {
    await accounts.addToGroup(email, input.type);
    await withTransaction(db, async (tx) => {
      await tx.query(
        `INSERT INTO users (id, status, created_by, updated_by, cognito_sub, name, email, mobile, type, department_ids,
           council_name, council_reg_no, reg_valid_till, pharmacist_reg_no, active)
         VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)`,
        [
          id, by, sub, input.name, email, input.mobile, input.type, JSON.stringify([...new Set(input.departmentIds)]),
          input.councilName ?? null, input.councilRegNo ?? null, input.regValidTill ?? null, input.pharmacistRegNo ?? null,
        ],
      );
      if (bundles.length > 0) {
        await tx.query(
          `INSERT INTO user_permissions (id, status, created_by, updated_by, user_id, allow, deny, bundles)
           VALUES ($1, 'active', $2, $2, $3, '[]', '[]', $4)`,
          [randomUUID(), by, sub, JSON.stringify(bundles)],
        );
      }
    });
  } catch (error) {
    await accounts.disable(email).catch((e: unknown) => console.error('Could not disable half-made account', email, e));
    if ((error as { code?: string }).code === '23505') throw emailTaken();
    throw error;
  }
  return getUser(db, id);
}

export interface UserChange {
  version: number;
  name?: string;
  mobile?: string;
  departmentIds?: string[];
  /** null clears it. */
  councilName?: string | null;
  councilRegNo?: string | null;
  regValidTill?: string | null;
  pharmacistRegNo?: string | null;
  reason?: string;
}

const COLUMNS = {
  name: 'name',
  mobile: 'mobile',
  councilName: 'council_name',
  councilRegNo: 'council_reg_no',
  regValidTill: 'reg_valid_till',
  pharmacistRegNo: 'pharmacist_reg_no',
} as const;

/** #156: edits a user's details (not email or type). The old row goes to users_versions. */
export async function updateUser(db: Queryable, id: string, change: UserChange, by: string): Promise<User> {
  const current = await getUser(db, id);
  const set: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
    if (change[key] !== undefined) set[column] = change[key];
  }
  if (change.departmentIds !== undefined) {
    await checkDepartments(db, change.departmentIds);
    set.department_ids = JSON.stringify([...new Set(change.departmentIds)]);
  }

  if (current.type === 'doctor' || current.type === 'head_doctor') {
    const missing = (['councilName', 'councilRegNo', 'regValidTill'] as const).filter((k) => change[k] === null);
    if (missing.length > 0) throw invalid(`doctors must keep: ${missing.join(', ')}`);
  }
  await updateRecord(db, 'users', { id, version: change.version, by, set, reason: change.reason });
  return getUser(db, id);
}

/** For #158-#162: nobody does these to their own account. */
export function assertNotSelf(user: User, by: string, what: string): void {
  if (user.cognitoSub === by) throw new AppError(403, 'forbidden', `nobody can ${what} their own account`);
}

/**
 * #158: disables the Cognito account (which also ends its sessions), then marks the user inactive.
 * 409 last_admin for the last active Admin. Deactivating an inactive user changes nothing.
 */
export async function deactivateUser(db: Queryable, accounts: StaffAccounts, id: string, by: string, reason: string): Promise<User> {
  const user = await getUser(db, id);
  assertNotSelf(user, by, 'deactivate');
  if (!user.active) return user;
  if (user.type === 'admin') await assertAdminRemains(db, { deactivate: user.cognitoSub });

  await accounts.disable(user.email);
  await updateRecord(db, 'users', { id, version: user.version, by, set: { active: false }, reason });
  return getUser(db, id);
}

/** #159: enables the Cognito account again, then marks the user active. Reactivating an active user changes nothing. */
export async function reactivateUser(db: Queryable, accounts: StaffAccounts, id: string, by: string, reason: string): Promise<User> {
  const user = await getUser(db, id);
  assertNotSelf(user, by, 'reactivate');
  if (user.active) return user;

  await accounts.enable(user.email);
  await updateRecord(db, 'users', { id, version: user.version, by, set: { active: true }, reason });
  return getUser(db, id);
}

/** #160: the user sets up their authenticator app again at next sign-in. Only for active users. */
export async function resetUserMfa(db: Queryable, accounts: StaffAccounts, id: string, by: string): Promise<User> {
  const user = await getUser(db, id);
  assertNotSelf(user, by, 'reset MFA on');
  if (!user.active) throw new AppError(409, 'inactive', 'reactivate the user first');
  await accounts.resetMfa(user.email);
  return user;
}
