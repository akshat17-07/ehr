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
const admin = asStaff('dev-admin', ['admin']);
const doctor = asStaff('dev-doctor', ['doctor']);
const json = { 'content-type': 'application/json' };
const place = (body: unknown, who = admin) => app.request('/admin/legal-holds', { method: 'POST', headers: json, body: JSON.stringify(body) }, who);
const release = (id: string, body: unknown, who = admin) =>
  app.request(`/admin/legal-holds/${id}/release`, { method: 'POST', headers: json, body: JSON.stringify(body) }, who);
const list = (q = '', who = admin) => app.request(`/admin/legal-holds${q}`, {}, who);

type Hold = {
  id: string; status: string; patientId: string; reason: string; reference: string | null; placedBy: string;
  releasedBy: string | null; releasedAt: string | null; releaseReason: string | null; version: number; uhid: string;
};
type PageOf = { items: Hold[]; nextCursor?: string };

describe('legal holds', () => {
  it('places a hold, lists newest first with filter and paging, audits with the patient', async () => {
    const old = await db.query(
      `INSERT INTO legal_holds (id, status, created_by, updated_by, created_at, updated_at, patient_id, reason, placed_by, released_at, released_by, release_reason)
       VALUES (gen_random_uuid(), 'released', 'p', 'p', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z', $1, 'Old case', 'unknown-sub', '2020-02-01T00:00:00Z', 'dev-admin', 'Done') RETURNING id`,
      [seedId('9a710000', 1)],
    );
    const oldId = String(old.rows[0]?.id);
    const voided = await db.query(
      `INSERT INTO legal_holds (id, status, created_by, updated_by, voided_at, patient_id, reason)
       VALUES (gen_random_uuid(), 'active', 'p', 'p', now(), $1, 'Voided') RETURNING id`,
      [seedId('9a710000', 1)],
    );
    const res = await place({ patientId: seedId('9a710000', 2), reason: 'Court order', reference: 'WP 123/2026' });
    expect(res.status).toBe(201);
    const hold = (await res.json()) as Hold;
    expect(hold).toMatchObject({
      status: 'active', patientId: seedId('9a710000', 2), reason: 'Court order', reference: 'WP 123/2026',
      placedBy: seedId('a0000000', 1), releasedAt: null, releasedBy: null, version: 1,
    });
    expect(hold.uhid).toBeTruthy();
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'legal_hold' AND record_id = $1", [hold.id]);
    expect(audit.rows.length).toBeGreaterThan(0);

    const all = ((await (await list()).json()) as PageOf).items;
    const ids = all.map((h) => h.id);
    expect(ids.indexOf(hold.id)).toBeLessThan(ids.indexOf(oldId));
    expect(ids).not.toContain(String(voided.rows[0]?.id));
    expect(all.find((h) => h.id === oldId)).toMatchObject({ placedBy: 'unknown-sub', releasedBy: seedId('a0000000', 1), releaseReason: 'Done', status: 'released' });
    const active = ((await (await list('?active=true')).json()) as PageOf).items;
    expect(active.every((h) => h.status === 'active')).toBe(true);
    expect(active.map((h) => h.id)).toContain(hold.id);
    const released = ((await (await list('?active=false')).json()) as PageOf).items;
    expect(released.every((h) => h.status === 'released')).toBe(true);
    expect(released.map((h) => h.id)).toContain(oldId);
    const paged = (await (await list('?limit=1')).json()) as PageOf;
    expect(paged.items).toHaveLength(1);
    expect(paged.nextCursor).toBeTruthy();
  });

  it('releases an active hold; 409 not_active when released again; the patient can be held again', async () => {
    const hold = (await (await place({ patientId: seedId('9a710000', 3), reason: 'Audit' })).json()) as Hold;
    const res = await release(hold.id, { reason: 'Case closed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: hold.id, status: 'released', releaseReason: 'Case closed', releasedBy: seedId('a0000000', 1), version: 2 });
    const again = await release(hold.id, { reason: 'Again' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('not_active');
    expect((await place({ patientId: seedId('9a710000', 3), reason: 'New case' })).status).toBe(201);
    const history = await db.query('SELECT 1 FROM legal_holds_versions WHERE record_id = $1', [hold.id]);
    expect(history.rows).toHaveLength(1);
  });

  it('409 already_held for a second active hold on a patient', async () => {
    expect((await place({ patientId: seedId('9a710000', 5), reason: 'First' })).status).toBe(201);
    const res = await place({ patientId: seedId('9a710000', 5), reason: 'Second' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('already_held');
  });

  it('404 for an unknown patient or hold; 403 for a doctor', async () => {
    const missing = await place({ patientId: seedId('9a710000', 999), reason: 'x' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe('patient_not_found');
    expect((await release(seedId('9a710000', 999), { reason: 'x' })).status).toBe(404);
    expect((await release('nope', { reason: 'x' })).status).toBe(404);
    expect((await place({ patientId: seedId('9a710000', 2), reason: 'x' }, doctor)).status).toBe(403);
    expect((await list('', doctor)).status).toBe(403);
    expect((await release(seedId('9a710000', 999), { reason: 'x' }, doctor)).status).toBe(403);
  });

  it('422 for bad bodies and queries', async () => {
    const p = seedId('9a710000', 2);
    expect((await place({ patientId: p })).status).toBe(422);
    expect((await place({ patientId: p, reason: '' })).status).toBe(422);
    expect((await place({ patientId: p, reason: 'x', reference: 'r'.repeat(201) })).status).toBe(422);
    expect((await place({ patientId: p, reason: 'x', extra: 1 })).status).toBe(422);
    expect((await place({ patientId: 'nope', reason: 'x' })).status).toBe(422);
    const hold = (await (await place({ patientId: seedId('9a710000', 6), reason: 'Z' })).json()) as Hold;
    expect((await release(hold.id, {})).status).toBe(422);
    expect((await release(hold.id, { reason: ' ' })).status).toBe(422);
    expect((await list('?active=maybe')).status).toBe(422);
  });
});
