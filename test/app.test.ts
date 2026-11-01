import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseGroups } from '../src/middleware/auth.js';

const app = createApp();

// Simulates what API Gateway's JWT authorizer passes to the Lambda.
function asUser(groups: string[]) {
  const claims = { sub: 'user-1', email: 'u@example.com', 'cognito:groups': `[${groups.join(' ')}]` };
  return { event: { requestContext: { authorizer: { jwt: { claims } } } } } as never;
}

describe('routing and auth', () => {
  it('GET /health is public', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it.each(['/staff/me', '/admin/me', '/patient/me', '/other/insurance/me', '/other/gp/me'])(
    '%s refuses a request without a token',
    async (path) => {
      const res = await app.request(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
    },
  );

  it('unknown routes return 404 in the standard shape', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('group check per prefix', () => {
  const cases: [path: string, group: string, status: number][] = [
    ['/staff/me', 'doctor', 200],
    ['/staff/me', 'staff', 200],
    ['/staff/me', 'nurse', 200],
    ['/staff/me', 'medical', 200],
    ['/staff/me', 'admin', 200],
    ['/staff/me', 'insurance', 403],
    ['/staff/me', 'gp', 403],
    ['/admin/me', 'admin', 200],
    ['/admin/me', 'head_doctor', 200],
    ['/admin/me', 'doctor', 403],
    ['/admin/me', 'staff', 403],
    ['/other/insurance/me', 'insurance', 200],
    ['/other/insurance/me', 'doctor', 403],
    ['/other/gp/me', 'gp', 200],
    ['/other/gp/me', 'insurance', 403],
  ];

  it.each(cases)('%s as %s → %i', async (path, group, status) => {
    const res = await app.request(path, {}, asUser([group]));
    expect(res.status).toBe(status);
    if (status === 403) expect(await res.json()).toMatchObject({ error: 'wrong_group' });
  });
});

describe('parseGroups', () => {
  it('reads the HTTP API string format', () => {
    expect(parseGroups('[admin doctor]')).toEqual(['admin', 'doctor']);
  });
  it('handles arrays and empty values', () => {
    expect(parseGroups(['nurse'])).toEqual(['nurse']);
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups('')).toEqual([]);
  });
});
