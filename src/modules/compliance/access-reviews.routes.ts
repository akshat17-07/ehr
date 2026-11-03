import { Hono } from 'hono';
import { auditDetails } from '../../middleware/audit.js';
import type { AuthEnv } from '../../middleware/auth.js';
import { dbOf, userOf } from '../../middleware/context.js';
import { requirePermission } from '../../permissions/check.js';
import { createAccessReview, listAccessReviews, newReviewBody, reviewListQuery } from './access-reviews.js';

// Mounted at /admin/access-reviews.
export const adminAccessReviewsRoutes = new Hono<AuthEnv>()
  // #342
  .get('/', requirePermission('audit.review'), async (c) => {
    const query = reviewListQuery.parse(c.req.query());
    auditDetails(c, { recordType: 'access_review' });
    return c.json(await listAccessReviews(await dbOf(c), query));
  })
  // #343
  .post('/', requirePermission('audit.review'), async (c) => {
    const input = newReviewBody.parse(await c.req.json().catch(() => undefined));
    const review = await createAccessReview(await dbOf(c), input, userOf(c).sub);
    auditDetails(c, { recordType: 'access_review', recordId: review.id });
    return c.json(review, 201);
  });
