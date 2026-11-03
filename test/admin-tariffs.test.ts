import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const admin = asStaff('dev-admin', ['admin']);
const head = asStaff('dev-head-doctor', ['head_doctor']);

const post = (body: unknown, who = admin) =>
  app.request('/admin/tariffs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, who);
const item = (code: string, pricePaise = 35000, extra: object = {}) => ({ code, nameEn: `Item ${code}`, pricePaise, gstRate: 0, setting: 'opd', ...extra });
const rowsOf = async (code: string) =>
  (await db.query('SELECT list_version::int AS list_version, price_paise::text AS pp, valid_from::text AS vf, valid_to::text AS vt FROM tariffs WHERE code = $1 ORDER BY list_version', [code])).rows;

describe('POST /admin/tariffs', () => {
  it('adds list 2: the old price is end-dated and kept, new code added, other codes go on, audited', async () => {
    const dept = String((await db.query("SELECT id FROM departments WHERE code = 'LAB'")).rows[0]?.id);
    const before = Number((await db.query('SELECT count(*) AS n FROM tariffs')).rows[0]?.n);
    const res = await post({ validFrom: '2090-01-01', items: [item('opd-gen', 35000), item('NEW-1', 1000, { departmentId: dept, sacCode: '999311', gstRate: 18 })] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 2, count: 2, reminder: expect.stringContaining('CMHO') });

    expect(await rowsOf('OPD-GEN')).toEqual([
      { list_version: 1, pp: '30000', vf: '2024-04-01', vt: '2089-12-31' },
      { list_version: 2, pp: '35000', vf: '2090-01-01', vt: null },
    ]);
    expect(await rowsOf('NEW-1')).toHaveLength(1);
    expect(await rowsOf('IPD-GEN')).toMatchObject([{ vt: null }]);
    expect(Number((await db.query('SELECT count(*) AS n FROM tariffs')).rows[0]?.n)).toBe(before + 2);
    const { rows } = await db.query("SELECT record_id FROM audit_events WHERE record_type = 'tariff_list'");
    expect(rows).toEqual([{ record_id: '2' }]);

    // Today's staff list still shows the old price.
    const today = (await (await app.request('/staff/tariffs', {}, admin)).json()) as { code: string; pricePaise: number }[];
    expect(today.find((t) => t.code === 'OPD-GEN')?.pricePaise).toBe(30000);
  });

  it('409 when validFrom is not after the current list start', async () => {
    for (const validFrom of ['2090-01-01', '2089-06-01']) {
      const res = await post({ validFrom, items: [item('OPD-GEN')] });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'price_conflict' });
    }
    expect((await rowsOf('OPD-GEN')).length).toBe(2);
  });

  it('422 for a repeated code, an unknown department, a past date, and bad fields; nothing is written', async () => {
    const start = '2091-01-01';
    const n = async () => Number((await db.query('SELECT count(*) AS n FROM tariffs')).rows[0]?.n);
    const count = await n();
    expect((await post({ validFrom: start, items: [item('A1'), item('a1')] })).status).toBe(422);
    expect((await post({ validFrom: start, items: [item('A1', 100, { departmentId: '00000000-0000-4000-8000-000000000000' })] })).status).toBe(422);
    expect((await post({ validFrom: '2020-01-01', items: [item('A1')] })).status).toBe(422);
    expect((await post({ validFrom: start, items: [] })).status).toBe(422);
    expect((await post({ validFrom: start, items: [item('A1', -1)] })).status).toBe(422);
    expect((await post({ validFrom: start, items: [item('A1', 1.5)] })).status).toBe(422);
    expect((await post({ validFrom: start, items: [item('A1', 100, { gstRate: 7 })] })).status).toBe(422);
    expect((await post({ validFrom: start, items: [item('A1', 100, { sacCode: '12' })] })).status).toBe(422);
    expect((await post({ validFrom: start, items: [item('A1', 100, { setting: 'er' })] })).status).toBe(422);
    expect((await post({ validFrom: start, items: [item('bad code!')] })).status).toBe(422);
    expect((await post({ validFrom: start, items: Array.from({ length: 1001 }, (_, i) => item(`X${i}`)) })).status).toBe(422);
    expect(await n()).toBe(count);
  });

  it('403 for a Head Doctor (Admin only)', async () => {
    expect((await post({ validFrom: '2092-01-01', items: [item('A1')] }, head)).status).toBe(403);
  });

  it('takes 1000 items in one go', async () => {
    const res = await post({ validFrom: '2093-01-01', items: Array.from({ length: 1000 }, (_, i) => item(`BULK-${i}`)) });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ version: 3, count: 1000 });
  });
});
