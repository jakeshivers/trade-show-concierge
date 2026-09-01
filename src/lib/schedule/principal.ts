import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The scheduler's credential, and the **second** principal in this product that
 * is not a person.
 *
 * `leads/intake.ts` made the argument in full and it holds unchanged: a service
 * caller given an `Actor` flows through `getActor()` into every store function
 * in the codebase, and the compiler stops caring. So a `SchedulerPrincipal` is
 * deliberately not an `Actor`, cannot be passed to `listShows` or
 * `getAlertFeed`, and carries one capability — running a named job for one org.
 *
 * One thing is different here and it is the more dangerous half. An intake key
 * *appends* a lead; a nightly run **erases** leads past their retention date.
 * That is the only irreversible act in this product, and it is now reachable by
 * an HTTP request from outside. Three things make that acceptable rather than
 * alarming, and none of them is the secret being long:
 *
 * - The job is named in the request and there is exactly one name. There is no
 *   parameter that selects *what* to erase; the retention dates were set when
 *   the leads were captured, by people, on a screen.
 * - Every run writes a `scheduled_runs` row before it does anything, including
 *   the runs that fail, so "what erased these forty leads and when" is a query.
 * - The secret is compared in constant time and there is no per-org variant, so
 *   a caller cannot enumerate orgs by timing. Which org runs is a body field
 *   read *after* the credential, never a way to find one.
 *
 * `CRON_SECRET` is deliberately the same variable name every hosted scheduler
 * uses, so step 21's hosting half is configuration rather than code.
 */

export type SchedulerPrincipal = {
  job: 'nightly';
  trigger: 'schedule';
};

export function schedulerSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env.CRON_SECRET?.trim() || null;
}

export type SchedulerRefusal = { status: number; message: string };

/**
 * The `Authorization` header → a principal, or a refusal.
 *
 * **No secret configured is a refusal, not a pass.** An endpoint that erases
 * personal data and is open because nobody set a variable is the failure mode
 * `authMode()` had — where one Clerk key present and one missing served a seeded
 * admin to everyone — and it is worse here, because this one is not a read.
 */
export function authenticateScheduler(
  header: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): { principal: SchedulerPrincipal } | { refusal: SchedulerRefusal } {
  const expected = schedulerSecret(env);
  if (!expected) {
    return {
      refusal: {
        status: 503,
        message:
          'No scheduler is configured for this workspace. Set CRON_SECRET and point a scheduler ' +
          'at this endpoint; until then the sweeps run only when somebody presses the button on ' +
          '/alerts, which is what that page says.',
      },
    };
  }

  const raw = (header ?? '').trim();
  const token = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw;
  if (!token || !constantTimeEqual(token, expected)) {
    return { refusal: { status: 401, message: 'Not a scheduler for this workspace.' } };
  }
  return { principal: { job: 'nightly', trigger: 'schedule' } };
}

function constantTimeEqual(a: string, b: string): boolean {
  // Hashing first so the comparison is over equal-length buffers; comparing raw
  // strings of different lengths throws, and catching that leaks the length.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
