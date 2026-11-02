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

describe('GET /staff/patients/{id}/dental-chart', () => {
  const chart = (patient: string, who = doctor) => app.request(`/staff/patients/${patient}/dental-chart`, {}, who);

  it("groups the patient's entries by tooth, oldest first", async () => {
    expect(await (await chart(ramesh)).json()).toEqual({ teeth: {} });
    for (const [tooth, condition, at] of [['36', 'Caries', '2026-01-10T05:00:00Z'], ['11', 'Fracture', '2026-02-01T05:00:00Z'], ['36', 'Filled', '2026-03-01T05:00:00Z']]) {
      await db.query(
        "INSERT INTO dental_entries (id, status, created_by, updated_by, patient_id, tooth, condition, at) VALUES (gen_random_uuid(), 'active', 'x', 'x', $1, $2, $3, $4)",
        [ramesh, tooth, condition, at],
      );
    }
    const body = (await (await chart(ramesh)).json()) as { teeth: Record<string, { condition: string }[]> };
    expect(Object.keys(body.teeth).sort()).toEqual(['11', '36']);
    expect(body.teeth['36']?.map((e) => e.condition)).toEqual(['Caries', 'Filled']);
  });

  it('404 for no patient; 403 for a nurse', async () => {
    expect((await chart(seedId('9a710000', 999))).status).toBe(404);
    expect((await chart(ramesh, nurse)).status).toBe(403);
  });
});
