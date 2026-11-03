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
const post = (body: unknown, who = admin) => app.request('/admin/access-reviews', { method: 'POST', headers: json, body: JSON.stringify(body) }, who);
const list = (q = '', who = admin) => app.request(`/admin/access-reviews${q}`, {}, who);

type Review = { id: string; month: string; reviewedBy: string | null; reviewedAt: string; notes: string; findings: string[] };

describe('access reviews', () => {
  it('creates a review, audits it, lists newest month first, filters by year', async () => {
    await db.query(
      `INSERT INTO access_reviews (id, status, created_by, updated_by, created_at, updated_at, month, notes, findings, reviewed_by)
       VALUES (gen_random_uuid(), 'active', 'p', 'p', '2024-03-02T00:00:00Z', '2024-03-02T00:00:00Z', '2024-02', 'Old', '["x"]', 'unknown-sub')`,
    );
    const res = await post({ month: '2025-01', notes: 'All fine', findings: ['Left user disabled'] });
    expect(res.status).toBe(201);
    const review = (await res.json()) as Review;
    expect(review).toMatchObject({ month: '2025-01', notes: 'All fine', findings: ['Left user disabled'], reviewedBy: seedId('a0000000', 1) });
    expect(review.reviewedAt).toBeTruthy();
    const audit = await db.query("SELECT 1 FROM audit_events WHERE record_type = 'access_review' AND record_id = $1", [review.id]);
    expect(audit.rows.length).toBeGreaterThan(0);
    const noFindings = (await (await post({ month: '2025-02', notes: 'n' })).json()) as Review;
    expect(noFindings.findings).toEqual([]);

    const all = ((await (await list()).json()) as { items: Review[] }).items;
    expect(all.map((r) => r.month)).toEqual(['2025-02', '2025-01', '2024-02']);
    expect(all[2]).toMatchObject({ reviewedBy: 'unknown-sub', findings: ['x'] });
    const y = ((await (await list('?year=2024')).json()) as { items: Review[] }).items;
    expect(y.map((r) => r.month)).toEqual(['2024-02']);
    expect((await list('?year=24')).status).toBe(422);
  });

  it('403 without audit.review', async () => {
    expect((await post({ month: '2025-03', notes: 'n' }, doctor)).status).toBe(403);
    expect((await list('', doctor)).status).toBe(403);
  });

  it('409 already_reviewed for the same month', async () => {
    expect((await post({ month: '2025-05', notes: 'n' })).status).toBe(201);
    const res = await post({ month: '2025-05', notes: 'again' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('already_reviewed');
  });

  it('422 for a bad or future month and bad bodies', async () => {
    for (const body of [
      { month: '2025-13', notes: 'n' },
      { month: '2025-1', notes: 'n' },
      { month: '2999-01', notes: 'n' },
      { month: '2025-06', notes: '' },
      { month: '2025-06', notes: 'n', findings: [''] },
      { month: '2025-06', notes: 'n', findings: Array(51).fill('f') },
      { month: '2025-06', notes: 'n', extra: 1 },
    ]) {
      expect((await post(body)).status).toBe(422);
    }
  });
});
