'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Field, Form, Input, Message, QuietSubmit, Select, Submit, ZonedDateTime } from '../_components/form-ui';
import { CarrierAndTracking } from './_carrier-field';
import { confirmArrival, trackPackage, withdrawArrival } from './actions';

/**
 * Track a package, from the board.
 *
 * The one screen a person opens holding a tracking number is this one, and until
 * now it had no way to take it: freight was entered on a show's Logistics tab,
 * behind a form built for a pallet. This is that form with everything a parcel
 * does not have taken off it — no pieces, no weight, no declared value, no
 * special handling — because a UPS carton of datasheets has none of those and
 * being asked for them is what makes somebody go back to the spreadsheet.
 *
 * Two things it keeps, and both are load-bearing:
 *
 * **The cost center**, because §4's rule has no parcel exemption. A $180
 * overnight is spend on a show, `/cost` adds it up, and a dimension added later
 * permanently orphans everything filed before it.
 *
 * **The dock window, but only when there is a dock.** Picking show-site
 * receiving reveals the "receiving opens" field and makes it required, exactly
 * as the full form does — a show-site row without it silently degrades to "any
 * time before the deadline is fine", which is the answer that gets a crate
 * refused. A parcel to a hotel has no dock, so it is never asked.
 */

export type PickableShow = {
  id: string;
  name: string;
  timezone: string;
  /** Move-in, when the show has one. Prefills the dock window rather than the deadline. */
  moveInAt: Date | null;
};

type CostCenter = { id: string; code: string; name: string };

export function TrackPackageForm({
  shows,
  costCenters,
}: {
  shows: PickableShow[];
  costCenters: CostCenter[];
}) {
  const [state, action, pending] = useActionState(trackPackage, {});
  const [showId, setShowId] = useState(shows[0]?.id ?? '');
  const [consignment, setConsignment] = useState('direct');

  const show = shows.find((s) => s.id === showId) ?? shows[0];
  if (!show) return null;

  return (
    <Form action={action} state={state} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CarrierAndTracking />

        <Field label="What is in it">
          <Input
            name="description"
            density="comfortable"
            required
            placeholder="Two boxes of datasheets"
          />
        </Field>

        <Field label="For which show">
          <Select
            name="showId"
            density="comfortable"
            value={showId}
            onChange={(e) => setShowId(e.target.value)}
          >
            {shows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field
          label="Going to"
          hint={
            consignment === 'direct'
              ? 'A hotel, an office or a person. No show dock and no drayage — this is the ordinary case for a small package.'
              : consignment === 'advance_warehouse'
                ? 'The contractor’s warehouse. It holds freight for weeks and shuts on a date printed in the service manual.'
                : consignment === 'show_site'
                  ? 'The show floor’s own dock, which is shut until move-in. Anything that turns up before it opens is refused.'
                  : 'Coming back to us after the show.'
          }
        >
          <Select
            name="consignment"
            density="comfortable"
            value={consignment}
            onChange={(e) => setConsignment(e.target.value)}
          >
            <option value="direct">Direct — a hotel, an office or a person</option>
            <option value="advance_warehouse">Advance warehouse</option>
            <option value="show_site">Show-site receiving</option>
            <option value="office">Back to the office (a return leg)</option>
          </Select>
        </Field>

        <Field
          label="Needs to be there by"
          hint={
            consignment === 'advance_warehouse'
              ? 'The cutoff from the service manual — one to three weeks before move-in, never move-in itself. Leave it blank rather than guess.'
              : 'Optional.'
          }
        >
          <ZonedDateTime
            dateName="mustArriveOn"
            timeName="mustArriveAt"
            timeZone={show.timezone}
            defaultTime="16:00"
          />
        </Field>

        <Field label="Cost center">
          <Select
            name="costCenterId"
            density="comfortable"
            required
            defaultValue={costCenters[0]?.id}
          >
            {costCenters.map((cc) => (
              <option key={cc.id} value={cc.id}>
                {cc.code} — {cc.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {consignment === 'show_site' && (
        <Field
          label="Receiving opens"
          hint="The dock is shut before this. Show-site freight has a window rather than a deadline, and without this edge the row is only checked against the far one."
        >
          <ZonedDateTime
            dateName="receivingOpensOn"
            timeName="receivingOpensAt"
            instant={show.moveInAt}
            timeZone={show.timezone}
            required
            defaultTime="08:00"
          />
        </Field>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Submit pending={pending} busy="Adding…">
          Track it
        </Submit>
        <Link
          href={`/shows/${show.id}/logistics#new-freight`}
          className="text-xs text-text-muted underline hover:no-underline"
        >
          Freight, with weight and pieces →
        </Link>
        <Message state={state} />
      </div>
    </Form>
  );
}

/**
 * The crate is actually here.
 *
 * Rendered on the board row that says `not confirmed at the booth`, which until
 * now was a sentence with nowhere to go. `delivered` is the carrier's word about
 * a **dock**; drayage moves it from there to the booth on its own schedule and
 * this app cannot see that, so the gap between the two is exactly what somebody
 * standing in the booth closes — and they are the person least likely to be able
 * to navigate three levels deep to do it.
 *
 * Available to anybody, and that is `access.ts`'s argument rather than this
 * screen's: the person who finds the crate is whoever is in the booth at 7am,
 * and a confirmation only a manager can give is one that never gets given.
 */
export function BoardReceiptForm({
  showId,
  shipmentId,
  receivedAt,
}: {
  showId: string;
  shipmentId: string;
  receivedAt: Date | string | null;
}) {
  const [state, action, pending] = useActionState(
    receivedAt ? withdrawArrival : confirmArrival,
    {},
  );
  return (
    <Form action={action} state={state}>
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shipmentId" value={shipmentId} />
      {receivedAt ? (
        <QuietSubmit pending={pending} busy="…">
          Withdraw
        </QuietSubmit>
      ) : (
        <QuietSubmit pending={pending} busy="Confirming…">
          Confirm at the booth
        </QuietSubmit>
      )}
      <Message state={state} />
    </Form>
  );
}
