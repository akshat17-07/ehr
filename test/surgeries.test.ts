import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { seedDev } from '../src/db/seed-dev.js';
import { seedId } from '../src/db/table.js';

const db = await openLocalDb();
await seedDev(db);
const app = createApp({ db: async () => db });

const asStaff = (sub: string, groups: string[]) =>
  ({ event: { requestContext: { authorizer: { jwt: { claims: { sub, 'cognito:groups': `[${groups.join(' ')}]` } } } } } }) as never;
const doctor = asStaff('dev-doctor', ['doctor']);
const nurse = asStaff('dev-nurse', ['nurse']);
const ramesh = seedId('9a710000', 1);
const irfan = seedId('9a710000', 3);
const surgeonId = seedId('a0000000', 4);

describe('GET /staff/surgeries', () => {
  const list = (query: string, who = doctor) => app.request(`/staff/surgeries?${query}`, {}, who);
  const plan = (patientId: string, at: string, surgeon: string, status = 'scheduled') =>
    db.query(
      `INSERT INTO surgeries (id, status, created_by, updated_by, patient_id, procedure, surgeon_id, team_ids, scheduled_at, venue, charges_paise, consent_document_ids)
       VALUES (gen_random_uuid(), $4, 'x', 'x', $1, 'Appendicectomy', $2, '[]', $3, 'own', 2500000, '[]')`,
      [patientId, surgeon, at, status],
    );

  it("lists the days' surgeries earliest first, with the patient; filters by surgeon and status", async () => {
    await plan(irfan, '2026-11-10T09:00:00+05:30', surgeonId);
    await plan(ramesh, '2026-11-10T07:30:00+05:30', surgeonId);
    await plan(ramesh, '2026-11-11T23:30:00+05:30', seedId('a0000000', 3), 'cancelled');
    await plan(irfan, '2026-11-12T00:30:00+05:30', surgeonId);
    const day = (await (await list('from=2026-11-10&to=2026-11-11')).json()) as { patientId: string; chargesPaise: number; teamIds: string[]; patient: { id: string } }[];
    expect(day.map((s) => s.patientId)).toEqual([ramesh, irfan, ramesh]);
    expect(day[0]).toMatchObject({ procedure: 'Appendicectomy', chargesPaise: 2500000, teamIds: [], venue: 'own', status: 'scheduled', patient: { id: ramesh } });
    expect(await (await list(`from=2026-11-10&to=2026-11-12&surgeonId=${surgeonId}`)).json()).toHaveLength(3);
    expect(await (await list('from=2026-11-10&to=2026-11-12&status=cancelled')).json()).toHaveLength(1);
  });

  it('422 without dates, for to before from or over 92 days; 403 for a nurse', async () => {
    expect((await list('from=2026-11-10')).status).toBe(422);
    expect((await list('from=2026-11-10&to=2026-11-09')).status).toBe(422);
    expect((await list('from=2026-01-01&to=2026-06-30')).status).toBe(422);
    expect((await list('from=2026-11-10&to=2026-11-10', nurse)).status).toBe(403);
  });
});
