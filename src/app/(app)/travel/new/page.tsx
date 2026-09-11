import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { missingForTicket } from '@/lib/profile/edit';
import { getMyProfile } from '@/lib/profile/store';
import { costCentersFor, showsForRequest, travelersFor } from '@/lib/travel/queue';
import {
  Card,
  PageHeader,
} from '../../_components/ui';
import { RequestForm } from './form';

/**
 * Open a travel request.
 *
 * Note what this screen does *not* do: it does not search. Opening a request
 * needs no provider and no key — the request is ours, the airline has nothing to
 * do with it yet — so this page works on a clean clone with nothing configured,
 * and only the search on the next screen is unavailable.
 *
 * The free-text box that SCOPE.md §6a describes (an LLM parsing "Vegas by
 * Tuesday noon, back Thursday night" into these fields) is not built. The
 * *seam* for it is: `travel_requests.raw_request_text` and
 * `constraints_confirmed_at` are in the schema, the agent refuses to search an
 * unconfirmed parse, and `availableActions` already surfaces the confirmation
 * step. What is missing is only the parser.
 */
export default async function NewTravelRequestPage() {
  const actor = await getActor();
  const [travelers, costCenters, shows, me] = await Promise.all([
    travelersFor(actor),
    costCentersFor(actor),
    showsForRequest(actor),
    getMyProfile(actor),
  ]);
  const missing = missingForTicket(me);

  return (
    <div className="space-y-6">
      <PageHeader
        title="New travel request"
        blurb={
          <>
            State the window you need to travel in, not a flight. The agent searches, ranks against
          the policy that applies to you, and either books it or sends it for approval.
          </>
        }
      />

      {/*
        Said here rather than at the point of purchase. The agent will happily
        search and price an itinerary for somebody with no date of birth on file
        and then refuse to ticket it — a correct refusal (`passengers.ts`: a
        plausible placeholder buys a real ticket that fails at the gate) arriving
        at the worst possible moment, on a held offer with a clock on it. The
        gaps are read from `missingForTicket`, which mirrors the agent's own
        checks rather than guessing at them a second time.
      */}
      {missing.length > 0 && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          Your travel profile is incomplete — we still need {missing.join(', ')}. You can file
          this request now, but no ticket can be issued until it is filled in.{' '}
          <Link href="/settings/profile" className="underline hover:no-underline">
            Add your details
          </Link>
          .
        </p>
      )}

      <Card>
        <RequestForm
          travelers={travelers}
          costCenters={costCenters}
          shows={shows.map((s) => ({
            id: s.id,
            name: s.name,
            airportCode: s.airportCode,
            timezone: s.timezone,
            startsOn: s.startsOn.toISOString().slice(0, 10),
          }))}
          me={{ id: actor.userId, costCenterId: actor.costCenterId }}
        />
      </Card>
    </div>
  );
}
