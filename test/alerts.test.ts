import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { listVersions } from '../src/db/records.js';
import { createAlert, markAlertRead, type Alert } from '../src/modules/alerts/alerts.js';

const db = await openLocalDb();
const app = createApp({ db: async () => db });

function call(path: string, sub = 'nurse-1', init: RequestInit = {}) {
  const claims = { sub, email: `${sub}@x.in`, 'cognito:groups': '[nurse]' };
  return app.request(path, init, { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never);
}
const page = async (path: string, sub?: string) => (await (await call(path, sub)).json()) as { items: Alert[]; nextCursor?: string };

describe('GET /staff/me/alerts', () => {
  it('lists only the caller alerts, newest first, page by page', async () => {
    for (const n of [1, 2, 3]) {
      await createAlert(db, { userId: 'nurse-1', kind: 'expiry', title: `Batch ${n} expires`, body: 'In 30 days', link: '/stock', by: 'stock_scan' });
    }
    await createAlert(db, { userId: 'doc-1', kind: 'breakglass', title: 'Not yours', body: 'x', by: 'u' });

    const first = await page('/staff/me/alerts?limit=2');
    expect(first.items.map((a) => a.title)).toEqual(['Batch 3 expires', 'Batch 2 expires']);
    expect(first.items[0]).toMatchObject({ kind: 'expiry', body: 'In 30 days', link: '/stock', createdAt: expect.any(String) });
    expect(first.items[0]).not.toHaveProperty('readAt');

    const second = await page(`/staff/me/alerts?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((a) => a.title)).toEqual(['Batch 1 expires']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('filters read / unread', async () => {
    await db.query("UPDATE alerts SET read_at = now() WHERE title = 'Batch 1 expires'");
    expect((await page('/staff/me/alerts?unread=true')).items.map((a) => a.title)).toEqual(['Batch 3 expires', 'Batch 2 expires']);
    expect((await page('/staff/me/alerts?unread=false')).items.map((a) => a.title)).toEqual(['Batch 1 expires']);
  });

  it('422 for a bad filter or cursor', async () => {
    expect((await call('/staff/me/alerts?unread=yes')).status).toBe(422);
    expect((await call('/staff/me/alerts?limit=0')).status).toBe(422);
    expect((await call('/staff/me/alerts?cursor=nonsense')).status).toBe(422);
  });
});

describe('POST /staff/me/alerts/{id}/read', () => {
  it('marks it read once, keeping the unread version in history', async () => {
    const alert = await createAlert(db, { userId: 'nurse-2', kind: 'approval', title: 'Approve', body: 'x', by: 'u' });
    const res = await call(`/staff/me/alerts/${alert.id}/read`, 'nurse-2', { method: 'POST' });
    expect(res.status).toBe(200);
    const read = (await res.json()) as Alert;
    expect(read).toMatchObject({ id: alert.id, readAt: expect.any(String) });

    const again = (await (await call(`/staff/me/alerts/${alert.id}/read`, 'nurse-2', { method: 'POST' })).json()) as Alert;
    expect(again.readAt).toBe(read.readAt);
    expect((await listVersions(db, 'alerts', alert.id, (r) => r.read_at)).map((v) => v.version)).toEqual([1, 2]);
  });

  it('404 for someone else’s alert, an unknown id or a bad id', async () => {
    const theirs = await createAlert(db, { userId: 'doc-9', kind: 'licence', title: 'Renew', body: 'x', by: 'u' });
    for (const id of [theirs.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      expect((await call(`/staff/me/alerts/${id}/read`, 'nurse-2', { method: 'POST' })).status).toBe(404);
    }
    expect((await page('/staff/me/alerts', 'doc-9')).items[0]).not.toHaveProperty('readAt');
  });

  it('two tabs at once: both get the read alert', async () => {
    const alert = await createAlert(db, { userId: 'nurse-3', kind: 'expiry', title: 'x', body: 'x', by: 'u' });
    const [a, b] = await Promise.all([markAlertRead(db, 'nurse-3', alert.id), markAlertRead(db, 'nurse-3', alert.id)]);
    expect(a.readAt).toBeDefined();
    expect(b.readAt).toBeDefined();
  });
});
