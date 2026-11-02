import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);

/** A referrer row straight in the table (POST /staff/referrers comes at #142). */
async function insertReferrer(name: string, phone: string | null, regNo: string | null, mergedInto: string | null = null) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO referrers (id, status, created_by, updated_by, name, name_search, town, phone, reg_no, merged_into, pseudo)
     VALUES ($1, 'active', 'test', 'test', $2, $3, 'Indore', $4, $5, $6, true)`,
    [id, name, name.toLowerCase(), phone, regNo, mergedInto],
  );
  return id;
}

describe('GET /staff/referrers', () => {
  it('finds by part of the name, the phone or the reg no., leaving out merged ones', async () => {
    const anil = await insertReferrer('Dr Anil Joshi', '9800000001', 'MP-12345');
    const anita = await insertReferrer('Dr Anita Rao', '9800000002', null);
    await insertReferrer('Dr Anil Joshi (old)', '9800000009', null, anil);
    const search = async (q: string) => ((await (await app.request(`/staff/referrers?q=${encodeURIComponent(q)}`, {}, doctor)).json()) as { id: string }[]).map((r) => r.id);
    expect(await search('ani')).toEqual([anil, anita]);
    expect(await search('9800000002')).toEqual([anita]);
    expect(await search('mp-12345')).toEqual([anil]);
    const [first] = (await (await app.request('/staff/referrers?q=anil', {}, doctor)).json()) as object[];
    expect(first).toMatchObject({ name: 'Dr Anil Joshi', town: 'Indore', phone: '9800000001', regNo: 'MP-12345', pseudo: true });
    expect(await search('100%')).toEqual([]);
  });

  it('422 for a too-short search; 403 without referrer.view', async () => {
    expect((await app.request('/staff/referrers?q=a', {}, doctor)).status).toBe(422);
    expect((await app.request('/staff/referrers?q=anil', {}, asStaff('dev-medical', ['medical']))).status).toBe(403);
  });
});
