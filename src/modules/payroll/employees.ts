import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { pageQuery, pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { decryptField, encryptField, maskField } from '../../lib/field-crypto.js';
import type { BaseFields } from '../patients/patients.js';

// Employees on the payroll (api-list.md Employee). PAN, UAN, ESIC and bank details are stored encrypted
// (lib/field-crypto.ts) and leave the API masked: '****' and the last 4 characters. Plaintext is never returned.

export interface Employee extends BaseFields {
  userId: string | null;
  name: string;
  designation: string;
  joinDate: string;
  pan: string;
  uan: string | null;
  esic: string | null;
  bankAccount: { name: string; number: string; ifsc: string };
  salaryStructureId: string;
  active: boolean;
}

const masked = async (enc: unknown) => (enc == null ? null : maskField(await decryptField(String(enc))));

export async function toEmployee(r: Record<string, unknown>): Promise<Employee> {
  const bank = JSON.parse(await decryptField(String(r.bank_enc))) as { name: string; number: string; ifsc: string };
  return {
    ...baseFields(r as unknown as BaseRow),
    // The API speaks users.id; storage keeps the Cognito sub.
    userId: r.user_id == null ? null : String(r.user_uuid ?? r.user_id),
    name: String(r.name),
    designation: String(r.designation),
    joinDate: r.join_date instanceof Date ? r.join_date.toISOString().slice(0, 10) : String(r.join_date).slice(0, 10),
    pan: (await masked(r.pan_enc)) as string,
    uan: await masked(r.uan_enc),
    esic: await masked(r.esic_enc),
    bankAccount: { name: bank.name, number: maskField(bank.number), ifsc: bank.ifsc },
    salaryStructureId: String(r.salary_structure_id),
    active: r.active === true,
  };
}

export const employeesQuery = pageQuery
  .extend({
    active: z.enum(['true', 'false']).optional(),
    q: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type EmployeesQuery = z.infer<typeof employeesQuery>;

const SELECT = 'SELECT e.*, u.id AS user_uuid FROM employees e LEFT JOIN users u ON u.cognito_sub = e.user_id';

/** #204: by name, then id. `q` matches part of the name or designation, ignoring case. */
export async function listEmployees(db: Queryable, query: EmployeesQuery): Promise<Page<Employee>> {
  const where: string[] = ['e.voided_at IS NULL'];
  const params: unknown[] = [];
  if (query.active !== undefined) {
    params.push(query.active === 'true');
    where.push(`e.active = $${params.length}`);
  }
  if (query.q) {
    params.push(`%${query.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(lower(e.name) LIKE $${params.length} OR lower(e.designation) LIKE $${params.length})`);
  }
  const page: PageQuery = { limit: query.limit, ...(query.cursor && { cursor: query.cursor }) };
  const raw = await pageRows(db, { select: SELECT, where, params, orderBy: ['e.name', 'e.id'], direction: 'asc' }, page, (r) => r);
  return { ...raw, items: await Promise.all(raw.items.map(toEmployee)) };
}

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
/** Trims and removes spaces (these are numbers and codes); with `upper`, also uppercases. Checked after this. */
const code = (upper: boolean, re: RegExp) =>
  z.preprocess((v) => (typeof v === 'string' ? (upper ? v.replace(/\s+/g, '').toUpperCase() : v.replace(/\s+/g, '')) : v), z.string().regex(re));

export const newEmployeeBody = z
  .object({
    userId: z.uuid().optional(),
    name: text(1, 200),
    designation: text(1, 100),
    joinDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d)),
    pan: code(true, /^[A-Z]{5}[0-9]{4}[A-Z]$/),
    uan: code(false, /^\d{12}$/).optional(),
    esic: code(false, /^\d{10}(\d{7})?$/).optional(),
    bankAccount: z
      .object({ name: text(1, 200), number: code(false, /^\d{9,18}$/), ifsc: code(true, /^[A-Z]{4}0[A-Z0-9]{6}$/) })
      .strict(),
    salaryStructureId: z.uuid(), // task 321 adds the salary_structures table and the existence check here
  })
  .strict();
export type NewEmployee = z.infer<typeof newEmployeeBody>;

/** #205: adds an employee with PAN, UAN, ESIC and bank details encrypted. userId is a users.id; the Cognito sub is stored. */
export async function addEmployee(db: Queryable, input: NewEmployee, by: string): Promise<Employee> {
  let sub: string | null = null;
  if (input.userId) {
    const { rows } = await db.query('SELECT cognito_sub FROM users WHERE id = $1 AND voided_at IS NULL', [input.userId]);
    if (!rows[0]) throw new AppError(422, 'user_unknown', 'no such user');
    sub = String(rows[0].cognito_sub);
    const taken = await db.query('SELECT 1 FROM employees WHERE user_id = $1', [sub]);
    if (taken.rows.length > 0) throw new AppError(409, 'user_has_employee', 'this user already has an employee record');
  }
  const { number, ifsc, name: bankName } = input.bankAccount;
  try {
    const { rows } = await db.query(
      `INSERT INTO employees (id, status, created_by, updated_by, user_id, name, designation, join_date, pan_enc, uan_enc, esic_enc, bank_enc, salary_structure_id, active)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true) RETURNING *`,
      [
        randomUUID(), by, sub, input.name, input.designation, input.joinDate,
        await encryptField(input.pan),
        input.uan ? await encryptField(input.uan) : null,
        input.esic ? await encryptField(input.esic) : null,
        await encryptField(JSON.stringify({ name: bankName, number, ifsc })),
        input.salaryStructureId,
      ],
    );
    return await toEmployee({ ...(rows[0] as Record<string, unknown>), user_uuid: input.userId });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AppError(409, 'user_has_employee', 'this user already has an employee record');
    throw err;
  }
}
