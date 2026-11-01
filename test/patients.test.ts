import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { yearsBetween } from '../src/modules/patients/patients.js';
import { indiaDate } from '../src/time/india.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

function asStaff(sub: string, groups: string[]) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}
const reception = asStaff('dev-reception', ['staff']);
type Summary = { uhid: string; name: string; ageYears?: number; inactive: boolean; mobile?: string };
const search = async (q: string, who = reception) => {
  const res = await app.request(`/staff/patients?q=${encodeURIComponent(q)}`, {}, who);
  return { status: res.status, body: (await res.json()) as { items: Summary[]; nextCursor?: string } };
};
const uhids = async (q: string) => (await search(q)).body.items.map((p) => p.uhid);

describe('GET /staff/patients', () => {
  it('finds by UHID, by mobile (a family shares one) and by the start of the name', async () => {
    expect(await uhids('u24000001')).toEqual(['U24000001']);
    expect(await uhids('+91 98260-00001')).toEqual(['U24000001', 'U24000002']);
    expect(await uhids('ra')).toEqual(['U26000005', 'U24000001']);
    expect(await uhids('Kumar')).toEqual([]);
  });

  it('gives summary fields only, with age and the inactive flag', async () => {
    const [ramesh] = (await search('U24000001')).body.items;
    expect(Object.keys(ramesh ?? {}).sort()).toEqual(['ageYears', 'dob', 'id', 'inactive', 'mobile', 'name', 'sex', 'uhid', 'unknown']);
    expect(ramesh).toMatchObject({ ageYears: yearsBetween('1968-05-14', indiaDate()), inactive: false });
    expect((await search('U24000002')).body.items[0]?.inactive).toBe(true);
    expect((await search('U25000004')).body.items[0]?.inactive).toBe(true);
    // Age given at registration (45 on 2025-06-01) counts on.
    expect((await search('U25000003')).body.items[0]?.ageYears).toBe(45 + yearsBetween('2025-06-01', indiaDate()));
  });

  it('pages, and leaves out merged patients', async () => {
    const first = await app.request('/staff/patients?q=9826000001&limit=1', {}, reception);
    const body = (await first.json()) as { items: Summary[]; nextCursor: string };
    expect(body.items.map((p) => p.uhid)).toEqual(['U24000001']);
    const next = await app.request(`/staff/patients?q=9826000001&limit=1&cursor=${body.nextCursor}`, {}, reception);
    expect(((await next.json()) as { items: Summary[] }).items.map((p) => p.uhid)).toEqual(['U24000002']);

    await db.query("UPDATE patients SET merged_into = id WHERE uhid = 'U24000002'");
    expect(await uhids('9826000001')).toEqual(['U24000001']);
  });

  it('422 for a 1-letter name; 403 without patient.search', async () => {
    expect((await search('r')).status).toBe(422);
    expect((await search('ra', asStaff('dev-gp', ['gp']))).status).toBe(403);
  });
});
