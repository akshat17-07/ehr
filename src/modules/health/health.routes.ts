import { Hono } from 'hono';

// Public: lets monitoring and developers check the API is up. Returns no data.
export const healthRoutes = new Hono().get('/', (c) => c.json({ ok: true }));
