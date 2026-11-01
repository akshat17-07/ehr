import { Hono } from 'hono';
import {
  GP_GROUPS,
  INSURANCE_GROUPS,
  MANAGEMENT_GROUPS,
  WORKFORCE_GROUPS,
  requireUser,
  type AuthEnv,
} from './middleware/auth.js';
import { getDb } from './db/client.js';
import type { Queryable } from './db/migrate.js';
import { auditRequests } from './middleware/audit.js';
import { onError, onNotFound } from './middleware/errors.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { meRoutes } from './modules/me/me.routes.js';

// Route prefixes match API Gateway (infra/constructs/api.ts). Full endpoint list: docs/india/api-list.md
//   /health             public
//   /staff/*            staff pool; admin, head_doctor, doctor, nurse, staff, medical (shared, per-endpoint permission)
//   /admin/*            staff pool; admin, head_doctor (per-endpoint permission; some are admin only)
//   /patient/*          patient pool; own (and linked family) records only
//   /other/insurance/*  staff pool; insurance agents, linked patients only
//   /other/gp/*         staff pool; referring GPs, own referrals only
export interface AppDeps {
  /** The database (tests pass an in-memory one). */
  db?: () => Promise<Queryable>;
}

export function createApp({ db = getDb }: AppDeps = {}) {
  const staff = new Hono<AuthEnv>().use(requireUser('staff', WORKFORCE_GROUPS)).route('/me', meRoutes);
  const admin = new Hono<AuthEnv>().use(requireUser('staff', MANAGEMENT_GROUPS)).route('/me', meRoutes);
  const patient = new Hono<AuthEnv>().use(requireUser('patient')).route('/me', meRoutes);
  const insurance = new Hono<AuthEnv>().use(requireUser('staff', INSURANCE_GROUPS)).route('/me', meRoutes);
  const gp = new Hono<AuthEnv>().use(requireUser('staff', GP_GROUPS)).route('/me', meRoutes);

  // Every request except /health gets an audit row (middleware/audit.ts).
  const audited = new Hono<AuthEnv>()
    .use(auditRequests(db))
    .route('/staff', staff)
    .route('/admin', admin)
    .route('/patient', patient)
    .route('/other/insurance', insurance)
    .route('/other/gp', gp)
    .onError(onError)
    .notFound(onNotFound);

  return new Hono<AuthEnv>()
    .route('/health', healthRoutes)
    .route('/', audited)
    .onError(onError)
    .notFound(onNotFound);
}
