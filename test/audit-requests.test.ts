import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { verifyAuditChain } from '../src/audit/log.js';
import { openLocalDb, type LocalDb } from '../src/db/local.js';

function lambda(groups: string[], sourceIp = '203.0.113.7') {
  const claims = { sub: 'user-1', email: 'u@example.com', 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } }, http: { sourceIp } } } } as never;
}

async function rows(db: LocalDb) {
  return (await db.query('SELECT user_id, role, action, record_type, record_id, ip, device FROM audit_events ORDER BY seq')).rows;
}

describe('audit every request', () => {
  let db: LocalDb;
  beforeEach(async () => {
    db = await openLocalDb();
  });
  afterEach(() => db.close());

  it('logs a read with who, what, IP and device', async () => {
    const app = createApp({ db: async () => db });
    const res = await app.request('/staff/me', { headers: { 'user-agent': 'Firefox/140' } }, lambda(['doctor']));
    expect(res.status).toBe(200);
    expect(await rows(db)).toEqual([
      {
        user_id: 'user-1',
        role: 'doctor',
        action: 'view',
        record_type: 'endpoint',
        record_id: 'GET /staff/me',
        ip: '203.0.113.7',
        device: 'Firefox/140',
      },
    ]);
  });

  it('logs refused requests as denied, with or without a user', async () => {
    const app = createApp({ db: async () => db });
    await app.request('/admin/me', {}, lambda(['nurse']));
    await app.request('/staff/me');
    const logged = await rows(db);
    expect(logged.map((r) => [r.user_id, r.role, r.action])).toEqual([
      ['user-1', 'nurse', 'denied'],
      ['anonymous', 'anonymous', 'denied'],
    ]);
  });

  it('never logs the query string', async () => {
    const app = createApp({ db: async () => db });
    await app.request('/staff/me?q=Ram%20Kumar', {}, lambda(['doctor']));
    expect((await rows(db))[0]?.record_id).toBe('GET /staff/me');
  });

  it('does not log /health (no records there)', async () => {
    const app = createApp({ db: async () => db });
    await app.request('/health');
    expect(await rows(db)).toEqual([]);
  });

  // 12 rows: past seq 10, where sorting seq as text ('9' > '10') once broke the chain.
  it('keeps the chain valid across many requests', async () => {
    const app = createApp({ db: async () => db });
    for (let i = 0; i < 12; i++) expect((await app.request('/staff/me', {}, lambda(['doctor']))).status).toBe(200);
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 12 });
  });

  it('returns 500 instead of the data when the audit row cannot be written', async () => {
    const app = createApp({
      db: async () => ({
        query: async () => {
          throw new Error('database down');
        },
      }),
    });
    const res = await app.request('/staff/me', {}, lambda(['doctor']));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
  });
});
