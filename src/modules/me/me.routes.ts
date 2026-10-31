import { Hono } from 'hono';
import type { AuthEnv } from '../../middleware/auth.js';

// Returns who the caller is, as seen by the API. Mounted under both /api and /portal.
export const meRoutes = new Hono<AuthEnv>().get('/', (c) => c.json(c.get('user')));
