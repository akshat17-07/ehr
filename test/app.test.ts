import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseGroups } from '../src/middleware/auth.js';

const app = createApp();

describe('routing and auth', () => {
  it('GET /health is public', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('staff routes refuse a request without a token', async () => {
    const res = await app.request('/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('patient routes refuse a request without a token', async () => {
    const res = await app.request('/portal/me');
    expect(res.status).toBe(401);
  });

  it('unknown routes return 404 in the standard shape', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
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
