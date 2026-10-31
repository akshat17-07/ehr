import { Hono } from 'hono';
import { requireUser, type AuthEnv } from './middleware/auth.js';
import { onError, onNotFound } from './middleware/errors.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { meRoutes } from './modules/me/me.routes.js';

// Route prefixes match API Gateway (infra/constructs/api.ts):
//   /health    public
//   /api/*     staff pool token required
//   /portal/*  patient pool token required
export function createApp() {
  const staff = new Hono<AuthEnv>().use(requireUser('staff')).route('/me', meRoutes);
  const portal = new Hono<AuthEnv>().use(requireUser('patient')).route('/me', meRoutes);

  return new Hono<AuthEnv>()
    .route('/health', healthRoutes)
    .route('/api', staff)
    .route('/portal', portal)
    .onError(onError)
    .notFound(onNotFound);
}
