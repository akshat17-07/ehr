import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openLocalDb } from '../src/db/local.js';
import { createAlert, type Alert } from '../src/modules/alerts/alerts.js';

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
