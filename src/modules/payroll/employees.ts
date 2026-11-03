import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { pageQuery, pageRows, type Page, type PageQuery } from '../../db/page.js';
import { updateRecord } from '../../db/records.js';
import { withTransaction } from '../../db/transaction.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { AppError } from '../../middleware/errors.js';
import { decryptField, encryptField, hashField, maskField } from '../../lib/field-crypto.js';
import type { BaseFields } from '../patients/patients.js';
import { UUID } from '../users/users.js';

// Employees on the payroll (api-list.md Employee). PAN, UAN, ESIC and bank details are stored encrypted
// (lib/field-crypto.ts) and leave the API masked: '****' and the last 4 characters. Plaintext is never returned.

export interface Employee extends BaseFields {
  userId: string | null;
  name: string;
  designation: string;
  joinDate: string;
  /** Last 4 digits only (UIDAI rule); null on old records. */
  aadhaar: string | null;
  pan: string | null;
  uan: string | null;
  esic: string | null;
  bankAccount: { name: string; number: string; ifsc: string } | null;
  salaryStructureId: string;
  active: boolean;
}

const masked = async (enc: unknown) => (enc == null ? null : maskField(await decryptField(String(enc))));

export async function toEmployee(r: Record<string, unknown>): Promise<Employee> {
  const bank = r.bank_enc == null ? null : (JSON.parse(await decryptField(String(r.bank_enc))) as { name: string; number: string; ifsc: string });
  return {
    ...baseFields(r as unknown as BaseRow),
    // The API speaks users.id; storage keeps the Cognito sub.
    userId: r.user_id == null ? null : String(r.user_uuid ?? r.user_id),
    name: String(r.name),
    designation: String(r.designation),
    joinDate: r.join_date instanceof Date ? r.join_date.toISOString().slice(0, 10) : String(r.join_date).slice(0, 10),
    aadhaar: await masked(r.aadhaar_enc),
    pan: await masked(r.pan_enc),
    uan: await masked(r.uan_enc),
    esic: await masked(r.esic_enc),
    bankAccount: bank && { name: bank.name, number: maskField(bank.number), ifsc: bank.ifsc },
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

/** #318: one employee, masked like the list; 404 if unknown, voided or not a UUID. */
export async function getEmployee(db: Queryable, id: string): Promise<Employee> {
  const { rows } = UUID.test(id) ? await db.query(`${SELECT} WHERE e.id = $1 AND e.voided_at IS NULL`, [id]) : { rows: [] };
  if (!rows[0]) throw new AppError(404, 'not_found');
  return toEmployee(rows[0] as Record<string, unknown>);
}

// Verhoeff checksum (the last Aadhaar digit).
const D = ['0123456789', '1234067895', '2340178956', '3401289567', '4012395678', '5987604321', '6598710432', '7659821043', '8765932104', '9876543210'];
const P = ['0123456789', '1576283094', '5803796142', '8916043527', '9453126870', '4286573901', '2793806415', '7046913258'];
export function verhoeffValid(num: string): boolean {
  let c = 0;
  [...num].reverse().forEach((ch, i) => {
    c = Number(D[c]?.[Number(P[i % 8]?.[Number(ch)])]);
  });
  return c === 0;
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
    aadhaar: z.preprocess(
      (v) => (typeof v === 'string' ? v.replace(/[\s-]+/g, '') : v),
      z.string().regex(/^[2-9]\d{11}$/).refine(verhoeffValid),
    ),
    pan: code(true, /^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(),
    uan: code(false, /^\d{12}$/).optional(),
    esic: code(false, /^\d{10}(\d{7})?$/).optional(),
    bankAccount: z
      .object({ name: text(1, 200), number: code(false, /^\d{9,18}$/), ifsc: code(true, /^[A-Z]{4}0[A-Z0-9]{6}$/) })
      .strict()
      .optional(),
    salaryStructureId: z.uuid(), // task 321 adds the salary_structures table and the existence check here
  })
  .strict();
export type NewEmployee = z.infer<typeof newEmployeeBody>;

/** #205: adds an employee with Aadhaar (required), PAN, UAN, ESIC and bank details encrypted. userId is a users.id; the Cognito sub is stored. */
export async function addEmployee(db: Queryable, input: NewEmployee, by: string): Promise<Employee> {
  let sub: string | null = null;
  if (input.userId) {
    const { rows } = await db.query('SELECT cognito_sub FROM users WHERE id = $1 AND voided_at IS NULL', [input.userId]);
    if (!rows[0]) throw new AppError(422, 'user_unknown', 'no such user');
    sub = String(rows[0].cognito_sub);
    const taken = await db.query('SELECT 1 FROM employees WHERE user_id = $1', [sub]);
    if (taken.rows.length > 0) throw new AppError(409, 'user_has_employee', 'this user already has an employee record');
  }
  const aadhaarHash = await hashField('aadhaar:', input.aadhaar);
  const same = await db.query('SELECT 1 FROM employees WHERE aadhaar_hash = $1', [aadhaarHash]);
  if (same.rows.length > 0) throw new AppError(409, 'duplicate_aadhaar', 'an employee with this Aadhaar number is on file');
  const bank = input.bankAccount;
  try {
    const { rows } = await db.query(
      `INSERT INTO employees (id, status, created_by, updated_by, user_id, name, designation, join_date, aadhaar_enc, aadhaar_hash, pan_enc, uan_enc, esic_enc, bank_enc, salary_structure_id, active)
       VALUES ($1, 'active', $2, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true) RETURNING *`,
      [
        randomUUID(), by, sub, input.name, input.designation, input.joinDate,
        await encryptField(input.aadhaar),
        aadhaarHash,
        input.pan ? await encryptField(input.pan) : null,
        input.uan ? await encryptField(input.uan) : null,
        input.esic ? await encryptField(input.esic) : null,
        bank ? await encryptField(JSON.stringify({ name: bank.name, number: bank.number, ifsc: bank.ifsc })) : null,
        input.salaryStructureId,
      ],
    );
    return await toEmployee({ ...(rows[0] as Record<string, unknown>), user_uuid: input.userId });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const msg = String((err as { message?: string }).message);
      if (/aadhaar/.test(msg)) throw new AppError(409, 'duplicate_aadhaar', 'an employee with this Aadhaar number is on file');
      throw new AppError(409, 'user_has_employee', 'this user already has an employee record');
    }
    throw err;
  }
}

const s_ = newEmployeeBody.shape;
export const employeeChange = z
  .object({
    version: z.number().int().min(1),
    name: s_.name.optional(),
    designation: s_.designation.optional(),
    joinDate: s_.joinDate.optional(),
    salaryStructureId: s_.salaryStructureId.optional(),
    active: z.boolean().optional(),
    userId: z.uuid().nullable().optional(),
    aadhaar: s_.aadhaar.optional(), // required on file: can be changed, never cleared
    pan: s_.pan.nullable(),
    uan: s_.uan.nullable(),
    esic: s_.esic.nullable(),
    bankAccount: s_.bankAccount.nullable(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type EmployeeChange = z.infer<typeof employeeChange>;

/** #319: edits an employee. Returns the saved employee and audit `changes`: values for plain fields, only ['changed'] / ['cleared'] for sensitive ones. */
export async function updateEmployee(
  db: Queryable,
  id: string,
  input: EmployeeChange,
  by: string,
): Promise<{ employee: Employee; changes: Record<string, [unknown, unknown]> }> {
  const { version, reason, ...fields } = input;
  if (Object.values(fields).every((v) => v === undefined)) throw new AppError(422, 'invalid_input', 'nothing to change');
  return withTransaction(db, async (tx) => {
    const { rows } = UUID.test(id) ? await tx.query(`${SELECT} WHERE e.id = $1 AND e.voided_at IS NULL`, [id]) : { rows: [] };
    const old = rows[0] as Record<string, unknown> | undefined;
    if (!old) throw new AppError(404, 'not_found');
    const set: Record<string, unknown> = {};
    const changes: Record<string, [unknown, unknown]> = {};
    const oldDate = old.join_date instanceof Date ? old.join_date.toISOString().slice(0, 10) : String(old.join_date).slice(0, 10);
    const plain = (key: string, col: string, now: unknown, was: unknown) => {
      if (now === undefined) return;
      set[col] = now;
      changes[key] = [was, now];
    };
    plain('name', 'name', fields.name, old.name);
    plain('designation', 'designation', fields.designation, old.designation);
    plain('joinDate', 'join_date', fields.joinDate, oldDate);
    plain('salaryStructureId', 'salary_structure_id', fields.salaryStructureId, old.salary_structure_id);
    plain('active', 'active', fields.active, old.active);

    if (fields.userId !== undefined) {
      let sub: string | null = null;
      if (fields.userId) {
        const u = await tx.query('SELECT cognito_sub FROM users WHERE id = $1 AND voided_at IS NULL', [fields.userId]);
        if (!u.rows[0]) throw new AppError(422, 'user_unknown', 'no such user');
        sub = String(u.rows[0].cognito_sub);
        const taken = await tx.query('SELECT 1 FROM employees WHERE user_id = $1 AND id <> $2', [sub, id]);
        if (taken.rows.length > 0) throw new AppError(409, 'user_has_employee', 'this user already has an employee record');
      }
      set.user_id = sub;
      changes.userId = [old.user_uuid ?? null, fields.userId];
    }
    if (fields.aadhaar !== undefined) {
      const hash = await hashField('aadhaar:', fields.aadhaar);
      const same = await tx.query('SELECT 1 FROM employees WHERE aadhaar_hash = $1 AND id <> $2', [hash, id]);
      if (same.rows.length > 0) throw new AppError(409, 'duplicate_aadhaar', 'an employee with this Aadhaar number is on file');
      set.aadhaar_enc = await encryptField(fields.aadhaar);
      set.aadhaar_hash = hash;
      changes.aadhaar = ['changed', 'changed'];
    }
    const secret = async (key: string, col: string, v: unknown) => {
      if (v === undefined) return;
      set[col] = v === null ? null : await encryptField(typeof v === 'string' ? v : JSON.stringify(v));
      changes[key] = v === null ? ['cleared', 'cleared'] : ['changed', 'changed'];
    };
    await secret('pan', 'pan_enc', fields.pan);
    await secret('uan', 'uan_enc', fields.uan);
    await secret('esic', 'esic_enc', fields.esic);
    await secret(
      'bankAccount',
      'bank_enc',
      fields.bankAccount && { name: fields.bankAccount.name, number: fields.bankAccount.number, ifsc: fields.bankAccount.ifsc },
    );
    if (fields.bankAccount === null) await secret('bankAccount', 'bank_enc', null);

    try {
      const row = await updateRecord(tx, 'employees', { id, version, by, set, ...(reason && { reason }) });
      const userUuid = 'userId' in fields && fields.userId !== undefined ? fields.userId : old.user_uuid;
      return { employee: await toEmployee({ ...row, user_uuid: userUuid }), changes };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        const msg = String((err as { message?: string }).message);
        if (/aadhaar/.test(msg)) throw new AppError(409, 'duplicate_aadhaar', 'an employee with this Aadhaar number is on file');
        throw new AppError(409, 'user_has_employee', 'this user already has an employee record');
      }
      throw err;
    }
  });
}
