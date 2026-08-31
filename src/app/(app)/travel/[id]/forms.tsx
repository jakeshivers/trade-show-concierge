'use client';

import { useActionState } from 'react';
import { approve, cancel, confirm, reject, search } from '../actions';
import { Button, money } from '../../_components/ui';
import type { FormState } from '../../_components/form';

/**
 * The action controls on a request.
 *
 * Each is its own form with its own `useActionState`, rather than one form with
 * several submit buttons, so a failed rejection cannot clear the approval box
 * and an error message is unambiguous about which action produced it.
 *
 * Note what none of them do: none takes an offer id, a price, or a policy
 * decision from the browser. The only thing that crosses is the request id and a
 * written reason — everything that determines what is bought is re-read on the
 * server. A form that posted the approved amount would be a form where the
 * amount could be edited.
 */

const field =
  'w-full rounded-md border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950';

function Result({ state }: { state: FormState }) {
  if (state.error)
    return (
      <p className="mt-2 rounded-md bg-rose-100 px-2 py-1.5 text-xs text-rose-900 dark:bg-rose-950 dark:text-rose-200">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p className="mt-2 rounded-md bg-emerald-100 px-2 py-1.5 text-xs text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
        {state.ok}
      </p>
    );
  return null;
}

export function Search({
  requestId,
  disabled,
  disabledReason,
}: {
  requestId: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(search, {});
  return (
    <form action={action} className="min-w-56">
      <input type="hidden" name="requestId" value={requestId} />
      <Button type="submit" disabled={pending || disabled}>
        {pending ? 'Searching…' : 'Search and evaluate'}
      </Button>
      <p className="mt-1 text-xs text-zinc-500">
        {disabled
          ? disabledReason
          : 'Searches, ranks against your policy, then books it or sends it for approval.'}
      </p>
      <Result state={state} />
    </form>
  );
}

export function Confirm({ requestId }: { requestId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(confirm, {});
  return (
    <form action={action} className="min-w-56">
      <input type="hidden" name="requestId" value={requestId} />
      <Button type="submit" disabled={pending}>
        Confirm these constraints
      </Button>
      <p className="mt-1 text-xs text-zinc-500">
        Nothing is searched until a person signs off on what the parser read.
      </p>
      <Result state={state} />
    </form>
  );
}

/**
 * Approve and reject, side by side.
 *
 * The approve button names the amount because that is what is being authorized —
 * "Approve up to $612" is the accurate verb, and the page above it has already
 * said whether $612 is a live fare or a ceiling.
 */
export function Decide({
  requestId,
  amountCents,
  needsBreakGlass,
}: {
  requestId: string;
  amountCents: number | null;
  needsBreakGlass: boolean;
}) {
  const [aState, approveAction, approving] = useActionState<FormState, FormData>(approve, {});
  const [rState, rejectAction, rejecting] = useActionState<FormState, FormData>(reject, {});

  return (
    <div className="w-full space-y-4">
      <form action={approveAction} className="space-y-2">
        <input type="hidden" name="requestId" value={requestId} />
        <input name="reason" className={field} placeholder="Note for the record (optional)" />
        {needsBreakGlass && (
          <div>
            <textarea
              name="breakGlassJustification"
              rows={2}
              className={field}
              placeholder="Break-glass justification — at least 20 characters"
            />
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              You opened this request. Self-approval is only possible if no other approver exists,
              and it is recorded as an exception rather than a normal approval.
            </p>
          </div>
        )}
        <Button type="submit" disabled={approving}>
          {approving
            ? 'Approving…'
            : amountCents === null
              ? 'Approve'
              : `Approve up to ${money(amountCents)}`}
        </Button>
        <Result state={aState} />
      </form>

      <form action={rejectAction} className="space-y-2">
        <input type="hidden" name="requestId" value={requestId} />
        <input
          name="reason"
          required
          className={field}
          placeholder="Why — the traveler needs to know what to change"
        />
        <Button type="submit" variant="secondary" disabled={rejecting}>
          {rejecting ? 'Rejecting…' : 'Reject'}
        </Button>
        <Result state={rState} />
      </form>
    </div>
  );
}

/**
 * Cancel — and an honest label on what it does not do.
 *
 * `cancelRequest` closes our record, releases any credit the booking consumed,
 * and writes off a non-refundable ticket as a new credit. It does **not** call
 * the airline: `FlightProvider.cancel()` is implemented and, as of step 9, is
 * called by nothing. That was invisible while cancelling was something only a
 * script could do. Putting a button on it makes the gap reachable by a person
 * who will reasonably assume the ticket is gone, so the button says otherwise
 * rather than waiting for voids and refunds to be built. See SCOPE.md §6d —
 * refunds and exchanges are their own step, and a half-wired cancel that
 * sometimes reaches the carrier would be worse than one that never claims to.
 */
export function Cancel({ requestId, ticketed }: { requestId: string; ticketed: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(cancel, {});
  return (
    <form action={action} className="min-w-56 space-y-2">
      <input type="hidden" name="requestId" value={requestId} />
      <input name="reason" className={field} placeholder="Reason (optional)" />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Cancelling…' : ticketed ? 'Close this record' : 'Cancel request'}
      </Button>
      {ticketed ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          This closes the record here and returns any credit the booking used. It does{' '}
          <strong>not</strong> cancel the ticket with the airline — voiding and refunding are not
          built yet, so call the carrier as well.
        </p>
      ) : (
        <p className="text-xs text-zinc-500">
          Nothing was bought, so there is nothing to unwind with the airline.
        </p>
      )}
      <Result state={state} />
    </form>
  );
}
