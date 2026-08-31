import { getActor } from '@/lib/auth/actor';
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
  const [travelers, costCenters, shows] = await Promise.all([
    travelersFor(actor),
    costCentersFor(actor),
    showsForRequest(actor),
  ]);

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
