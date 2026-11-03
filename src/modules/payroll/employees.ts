import { z } from 'zod';
import type { Queryable } from '../../db/migrate.js';
import { pageQuery, pageRows, type Page, type PageQuery } from '../../db/page.js';
import { baseFields, type BaseRow } from '../../db/table.js';
import { decryptField, maskField } from '../../lib/field-crypto.js';
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
