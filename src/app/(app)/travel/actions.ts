'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getDb } from '@/db';
import { getActor, ForbiddenError, type Actor } from '@/lib/auth/actor';
import { ProviderNotConfiguredError } from '@/lib/integrations/flights/types';
import { IllegalTransitionError } from '@/lib/travel/machine';
import { PurchasingHaltedError } from '@/lib/travel/kill-switch';
import { selectProvider } from '@/lib/travel/provider';
import { NotFoundError } from '@/lib/travel/queue';
import {
  ConcurrentUpdateError,
  HardCeilingError,
  RequestNotFoundError,
  approveRequest,
  cancelRequest,
  confirmConstraints,
  rejectRequest,
  runAgent,
  submitTravelRequest,
  type AgentDeps,
} from '@/lib/travel/agent';
import { zonedToInstant } from '@/lib/datetime/zoned';
import { type FormState, formErrorFrom, optional } from '../_components/form';

/**
 * The travel screens' writes.
 *
 * Every one of them re-resolves the actor server-side and then hands off to the
 * agent, which is where the rules live. The forms hide controls a role may not
 * use — `availableActions` in `lib/travel/review.ts` — but that is a courtesy,
 * exactly as on `/shows` and `/settings/security`. Separation of duties, the
 * kill switch, the hard ceiling, and the state machine are all enforced below
 * this file, and a hand-posted form hits every one of them.
 *
 * The deps are built per action rather than per module. `live` is re-read from
 * the environment inside `defaultDeps`, and a provider captured at import time
 * would be constructed during the build — see `lib/travel/provider.ts`.
 */

const EXPECTED = [
  ForbiddenError,
  NotFoundError,
  RequestNotFoundError,
  IllegalTransitionError,
  ConcurrentUpdateError,
  HardCeilingError,
  PurchasingHaltedError,
  ProviderNotConfiguredError,
];

const asFormError = formErrorFrom(EXPECTED, { messagedErrorsAreAnswers: true });

/** Built per call: never at module scope, and never captured across requests. */
function deps(): AgentDeps {
  return {
    db: getDb(),
    provider: selectProvider().provider,
    now: () => new Date(),
    live: process.env.FLIGHT_BOOKING_LIVE === 'true',
  };
}

/**
 * Opening a request does not need a provider — the request is ours, not the
 * airline's. Searching is a separate action for that reason: an install with no
 * Duffel key can still collect what people need, and only the search button is
 * unavailable.
 */
function depsWithoutProvider(): AgentDeps {
  return {
    db: getDb(),
    provider: null as never,
    now: () => new Date(),
    live: false,
  };
}

/**
 * Deliberately not the shared `str`: this one trims, because an airport code
 * with a trailing space is a failed search and a padded `datetime-local` string
 * does not parse. The shared helper is left verbatim rather than quietly given a
 * trim that four other screens never had.
 */
function str(form: FormData, key: string): string {
  return String(form.get(key) ?? '').trim();
}

/**
 * A local date and time entered in a zone, as an instant.
 *
 * The form asks for departure windows in the *origin airport's* local time,
 * because that is the only reading a traveler has. Parsing it with `new Date()`
 * would resolve it in the server's zone — the exact bug `lib/datetime/zoned.ts`
 * exists to prevent.
 */
function localToInstant(form: FormData, key: string, timezone: string): Date {
  // `datetime-local` yields "2027-04-12T08:30" — already the naive shape
  // `zonedToInstant` wants, and deliberately not passed through `new Date()`
  // on the way.
  return zonedToInstant(str(form, key), timezone);
}

export async function openRequest(_prev: FormState, form: FormData): Promise<FormState> {
  const actor: Actor = await getActor();
  const timezone = str(form, 'timezone') || 'UTC';

  let id: string;
  try {
    const row = await submitTravelRequest(
      {
        travelerId: optional(form, 'travelerId') ?? actor.userId,
        showId: optional(form, 'showId'),
        costCenterId: optional(form, 'costCenterId'),
        originAirport: str(form, 'originAirport').toUpperCase(),
        destinationAirport: str(form, 'destinationAirport').toUpperCase(),
        earliestDeparture: localToInstant(form, 'earliestDeparture', timezone),
        latestArrival: localToInstant(form, 'latestArrival', timezone),
        returnEarliestDeparture: optional(form, 'returnEarliestDeparture')
          ? localToInstant(form, 'returnEarliestDeparture', timezone)
          : null,
        returnLatestArrival: optional(form, 'returnLatestArrival')
          ? localToInstant(form, 'returnLatestArrival', timezone)
          : null,
        cabinPreference: optional(form, 'cabinPreference'),
        notes: optional(form, 'notes'),
      },
      actor,
      depsWithoutProvider(),
    );
    id = row.id;
  } catch (err) {
    return asFormError(err);
  }

  revalidatePath('/travel');
  redirect(`/travel/${id}`);
}

export async function search(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const id = str(form, 'requestId');

  try {
    const outcome = await runAgent(id, deps(), actor);
    revalidatePath('/travel');
    revalidatePath('/travel/approvals');
    revalidatePath(`/travel/${id}`);
    return { ok: `Agent finished: ${outcome.status.replace('_', ' ')}.` };
  } catch (err) {
    return asFormError(err);
  }
}

export async function confirm(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const id = str(form, 'requestId');
  try {
    await confirmConstraints(id, actor, depsWithoutProvider());
  } catch (err) {
    return asFormError(err);
  }
  revalidatePath(`/travel/${id}`);
  return { ok: 'Constraints confirmed. The agent may search now.' };
}

/**
 * Approving authorizes an *amount*. If the offer died while this sat in the
 * queue, `approveRequest` re-searches and holds the result to the approved
 * price — which is why the screen tells the approver, before they press it,
 * which of the two they are doing. SCOPE.md §6b.
 */
export async function approve(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const id = str(form, 'requestId');

  try {
    const outcome = await approveRequest(id, actor, deps(), {
      reason: optional(form, 'reason') ?? undefined,
      breakGlassJustification: optional(form, 'breakGlassJustification') ?? undefined,
    });
    revalidatePath('/travel');
    revalidatePath('/travel/approvals');
    revalidatePath(`/travel/${id}`);
    return {
      ok:
        outcome.status === 'pending_approval'
          ? 'Re-priced above what you approved, so it is back in the queue for a fresh decision.'
          : `Approved — the request is now ${outcome.status.replace('_', ' ')}.`,
    };
  } catch (err) {
    return asFormError(err);
  }
}

export async function reject(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const id = str(form, 'requestId');
  const reason = str(form, 'reason');
  if (!reason) {
    return { error: 'A rejection needs a reason — the traveler has to know what to change.' };
  }

  try {
    await rejectRequest(id, actor, reason, depsWithoutProvider());
  } catch (err) {
    return asFormError(err);
  }
  revalidatePath('/travel');
  revalidatePath('/travel/approvals');
  revalidatePath(`/travel/${id}`);
  return { ok: 'Rejected.' };
}

export async function cancel(_prev: FormState, form: FormData): Promise<FormState> {
  const actor = await getActor();
  const id = str(form, 'requestId');
  const reason = str(form, 'reason') || 'Cancelled from the travel screen';

  try {
    await cancelRequest(id, actor, reason, depsWithoutProvider());
  } catch (err) {
    return asFormError(err);
  }
  revalidatePath('/travel');
  revalidatePath('/travel/approvals');
  revalidatePath(`/travel/${id}`);
  return { ok: 'Cancelled.' };
}
