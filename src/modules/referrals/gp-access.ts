import { AppError } from '../../middleware/errors.js';

// Which referrals a GP may see (api-list.md Referral, /other/gp/referrals*). The GP's referrer rows are those whose
// user_id is the caller's users.id, plus duplicates merged into one of them. Anything else is one plain 403.

export const notOwnReferral = () => new AppError(403, 'forbidden', 'not a referral of this doctor');

/**
 * SQL for "referrals.referrer_id is a referrer of the GP with Cognito sub $sub (or merged into one), not voided", for a
 * WHERE clause. The caller's query must have `referrals` in scope.
 */
export const OWN_REFERRAL = (sub: string) =>
  `referrals.voided_at IS NULL AND (
     referrals.referrer_id IN (SELECT r.id FROM referrers r WHERE r.user_id IN (SELECT u.id FROM users u WHERE u.cognito_sub = ${sub}))
     OR referrals.referrer_id IN (SELECT r.id FROM referrers r WHERE r.merged_into IN
       (SELECT r2.id FROM referrers r2 WHERE r2.user_id IN (SELECT u.id FROM users u WHERE u.cognito_sub = ${sub}))))`;
