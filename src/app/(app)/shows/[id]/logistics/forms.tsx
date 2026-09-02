'use client';

import { useActionState, useState } from 'react';
import type { ShipmentRow } from '@/lib/shipping/board';
import { CarrierAndTracking } from '../../../shipping/_carrier-field';
import { Badge } from '../../../_components/ui';
import { Field, Input, Message, QuietSubmit, Select, Submit, Textarea, ZonedDateTime } from '../../../_components/form-ui';
import {
  addTimelineEntry,
  confirmArrival,
  createShipment,
  removeShipment,
  updateShipment,
  withdrawArrival,
} from './actions';

export type Person = { id: string; fullName: string };
export type CostCenter = { id: string; code: string; name: string };

/**
 * The consignment control, with its meaning on the label rather than in a doc.
 *
 * These two options are the whole of §5g's window model as a form field, and a
 * person picking between them is deciding what "on time" means for this crate.
 * Naming them "advance warehouse" and "show site" and leaving it there would be
 * a dropdown nobody could answer correctly without already knowing the answer.
 */
type Consignment = 'advance_warehouse' | 'show_site' | 'office' | 'direct';

function ConsignmentField({
  value,
  onChange,
}: {
  value: Consignment;
  onChange: (v: Consignment) => void;
}) {
  return (
    <Field label="Consigned to">
      <Select
        name="consignment"
        density="comfortable"
        value={value}
        onChange={(e) => onChange(e.target.value as Consignment)}
      >
        <option value="advance_warehouse">
          Advance warehouse — holds freight for weeks, closes on a published date
        </option>
        <option value="show_site">
          Show-site receiving — dock opens with move-in; early freight is refused
        </option>
        <option value="office">Office — the crate coming back to us</option>
        <option value="direct">
          Direct — to a hotel, an office or a person; no show dock, no drayage
        </option>
      </Select>
    </Field>
  );
}

function Fields({
  showId,
  timezone,
  people,
  costCenters,
  row,
}: {
  showId: string;
  timezone: string;
  people: Person[];
  costCenters: CostCenter[];
  row?: ShipmentRow;
}) {
  const c = row?.shipment;
  const [consignment, setConsignment] = useState<Consignment>(
    (c?.consignment as Consignment) ?? 'advance_warehouse',
  );
  return (
    <>
      <input type="hidden" name="showId" value={showId} />
      {c && <input type="hidden" name="shipmentId" value={c.id} />}

      <Field label="What is in it">
        <Input
          name="description"
          density="comfortable"
          required
          defaultValue={c?.description}
          placeholder="Booth crate 1 of 2 — 20x20 island"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Direction">
          <Select name="direction" density="comfortable" defaultValue={c?.direction ?? 'outbound'}>
            <option value="outbound">Outbound — to the show</option>
            <option value="return">Return — back to us</option>
          </Select>
        </Field>
        <ConsignmentField value={consignment} onChange={setConsignment} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {/* The board's control, not a second copy of it. Two screens each
            reading a tracking number their own way can disagree about what it
            says, and nothing would catch it — `_present.tsx`'s argument, applied
            to a form rather than to a badge. */}
        <CarrierAndTracking
          defaultCarrier={c?.carrier ?? 'fedex'}
          defaultTracking={c?.trackingNumber ?? ''}
          trackingHint="Blank is fine. Until there is one this row is a plan, not a crate."
        />
      </div>

      <Field
        label="Must arrive by"
        hint={
          consignment === 'advance_warehouse'
            ? 'The advance warehouse cutoff from the service manual — usually one to three weeks before move-in, not move-in itself. Left blank if it has not been read off the manual yet.'
            : consignment === 'direct'
              ? 'When it has to be there — the day somebody checks in, usually. Blank is fine; nothing here is a dock, so there is no cutoff to miss.'
              : 'The end of show-site receiving, usually the close of move-in.'
        }
      >
        <ZonedDateTime
          dateName="mustArriveOn"
          timeName="mustArriveAt"
          instant={c?.mustArriveBy ?? null}
          timeZone={timezone}
          defaultTime="16:00"
        />
      </Field>

      {consignment === 'show_site' && (
        <Field
          label="Receiving opens"
          hint="The dock is shut before this. Freight that arrives early is refused, held at the carrier's rate, or returned — which is why show-site freight has a window rather than a deadline."
        >
          <ZonedDateTime
            dateName="receivingOpensOn"
            timeName="receivingOpensAt"
            instant={c?.receivingOpensAt ?? null}
            timeZone={timezone}
            required
            defaultTime="08:00"
          />
        </Field>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Owner"
          hint="Who chases it. Left blank, an alert about this crate goes to whoever runs the show instead — it never goes quiet."
        >
          <Select name="ownerId" density="comfortable" defaultValue={row?.ownerId ?? ''}>
            <option value="">Nobody yet</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </Select>
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

      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Pieces">
          <Input name="pieces" density="comfortable" defaultValue={c?.pieces ?? 1} />
        </Field>
        <Field label="Weight (lb)">
          <Input name="weightLb" density="comfortable" defaultValue={row?.costs.weightLb ?? ''} />
        </Field>
        <Field label="Declared value">
          <Input
            name="declaredValue"
            density="comfortable"
            defaultValue={
              row?.costs.declaredValueCents != null ? (row.costs.declaredValueCents / 100).toFixed(2) : ''
            }
          />
        </Field>
        <Field label="Freight cost">
          <Input
            name="cost"
            density="comfortable"
            defaultValue={row?.costs.costCents != null ? (row.costs.costCents / 100).toFixed(2) : ''}
          />
        </Field>
      </div>

      <Field label="Notes">
        <Textarea name="notes" density="comfortable" rows={2} defaultValue={c ? undefined : ''} />
      </Field>
    </>
  );
}

export function NewShipmentForm(props: {
  showId: string;
  timezone: string;
  people: Person[];
  costCenters: CostCenter[];
}) {
  const [state, action, pending] = useActionState(createShipment, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Submit type="button" onClick={() => setOpen(true)}>
          Add a shipment
        </Submit>
        <Message state={state} />
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <Fields {...props} />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Adding…">
          Add shipment
        </Submit>
        <QuietSubmit type="button" onClick={() => setOpen(false)}>
          Cancel
        </QuietSubmit>
        <Message state={state} />
      </div>
    </form>
  );
}

export function EditShipmentForm(props: {
  showId: string;
  timezone: string;
  people: Person[];
  costCenters: CostCenter[];
  row: ShipmentRow;
}) {
  const [state, action, pending] = useActionState(updateShipment, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <>
        <QuietSubmit type="button" onClick={() => setOpen(true)}>
          Edit
        </QuietSubmit>
        <Message state={state} />
      </>
    );
  }

  return (
    <form action={action} className="mt-3 space-y-3 rounded-lg border border-border p-3">
      <Fields {...props} />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Saving…">
          Save
        </Submit>
        <QuietSubmit type="button" onClick={() => setOpen(false)}>
          Cancel
        </QuietSubmit>
        <Message state={state} />
      </div>
    </form>
  );
}

/**
 * Delete, with the sentence the store makes you acknowledge.
 *
 * Same shape as un-staffing somebody and as cancelling a ticketed request: the
 * first press is refused with a description of what deleting does *not* do, and
 * the second carries the acknowledgement. The freight is with a carrier and a
 * row disappearing here changes nothing about a pallet on a truck.
 */
export function DeleteShipmentForm({ showId, shipmentId }: { showId: string; shipmentId: string }) {
  const [state, action, pending] = useActionState(removeShipment, {});
  return (
    <form action={action} className="inline">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shipmentId" value={shipmentId} />
      {state.error && <input type="hidden" name="acknowledged" value="yes" />}
      <QuietSubmit pending={pending} busy="Deleting…">
        {state.error ? 'Delete anyway' : 'Delete'}
      </QuietSubmit>
      <Message state={state} className="mt-1" />
    </form>
  );
}

/**
 * The control that means the crate is actually here.
 *
 * Available to anybody, which `access.ts` argues for at length: the person who
 * finds the crate at the booth is whoever is standing in it at 7am, and a
 * confirmation only a manager can give is one that never gets given — at which
 * point every delivered crate stays flagged and the flag stops meaning anything.
 */
export function ReceiptForm({
  showId,
  row,
}: {
  showId: string;
  row: ShipmentRow;
}) {
  const [state, action, pending] = useActionState(
    row.shipment.receivedAt ? withdrawArrival : confirmArrival,
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shipmentId" value={row.shipment.id} />
      {row.shipment.receivedAt ? (
        <>
          <Badge tone="good">at the booth</Badge>
          <QuietSubmit pending={pending} busy="…">
            Withdraw
          </QuietSubmit>
        </>
      ) : (
        <Submit pending={pending} busy="Confirming…">
          Confirm it reached the booth
        </Submit>
      )}
      <Message state={state} />
    </form>
  );
}

/** For `carrier: other` — freight forwarders are a phone call, not an API. */
export function ManualScanForm({ showId, shipmentId }: { showId: string; shipmentId: string }) {
  const [state, action, pending] = useActionState(addTimelineEntry, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <QuietSubmit type="button" onClick={() => setOpen(true)}>
        Record something by hand
      </QuietSubmit>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-2 rounded-lg border border-border p-3">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" name="occurredOn" required />
        <Input type="time" name="occurredAt" defaultValue="12:00" />
        <Select name="status" defaultValue="in_transit">
          <option value="pre_transit">pre transit</option>
          <option value="in_transit">in transit</option>
          <option value="out_for_delivery">out for delivery</option>
          <option value="delivered">delivered</option>
          <option value="exception">exception</option>
        </Select>
      </div>
      <Input name="message" required placeholder="Collected by forwarder" className="w-full" />
      <Input name="location" placeholder="Fremont, CA" className="w-full" />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Recording…">
          Record
        </Submit>
        <QuietSubmit type="button" onClick={() => setOpen(false)}>
          Cancel
        </QuietSubmit>
        <Message state={state} />
      </div>
      <p className="text-xs text-text-muted">
        Marked as entered by hand, never as reported by a carrier — and fingerprinted the same
        way a real scan is, so if a tracker is configured later the same event does not appear
        twice.
      </p>
    </form>
  );
}
