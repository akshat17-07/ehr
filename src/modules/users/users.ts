import type { Queryable } from '../../db/migrate.js';
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
