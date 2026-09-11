import { optionalDecimalToCents } from '@/lib/money/decimal';
import { TeamError } from '@/lib/team/edit';
import type { Consignment } from './status';

/**
 * Shipping, as pure functions.
 *
 * Validation, plus the two rules that come out of the window model rather than
 * out of a form library:
 *
 * **A show-site consignment without a receiving open time is a deadline model
 * wearing a window's name.** The whole reason `too_early` exists is that the
 * dock is shut before move-in; a show-site row with no open time silently
 * degrades to "any time before the deadline is fine", which is the answer that
 * gets a crate refused. So it is required — and it defaults to the show's
 * move-in instant, because that is what it is, and asking somebody to retype a
 * date the app already holds is how the two copies diverge.
 *
 * **An advance warehouse deadline is not move-in and must not be defaulted to
 * it.** Advance warehouses close one to three weeks before a show opens. A
 * `must_arrive_by` quietly defaulted to move-in would be wrong by a fortnight in
 * the expensive direction, and would look right on every screen. It has to be
 * read off the service manual, which is exactly the document the §5a register
 * exists to hold — so an advance-warehouse row with no deadline is allowed, and
 * says on the screen that the date is unread rather than inventing one.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Docks close in the afternoon; freight cutoffs are quoted at the hour. */
export const DEFAULT_CUTOFF_TIME = '16:00';

export type ShipmentDraft = {
  description: string;
  direction: 'outbound' | 'return';
  consignment: Consignment;
  carrier: string;
  trackingNumber?: string | null;
  ownerId?: string | null;
  mustArriveOn?: string | null;
  mustArriveAt?: string | null;
  receivingOpensOn?: string | null;
  receivingOpensAt?: string | null;
  pieces?: string | null;
  weightLb?: string | null;
  /** A decimal string as typed, e.g. "1450.00". Never a float. */
  declaredValue?: string | null;
  cost?: string | null;
  costCenterId: string;
  notes?: string | null;
};

export type ValidatedShipment = {
  description: string;
  direction: 'outbound' | 'return';
  consignment: Consignment;
  carrier: string;
  trackingNumber: string | null;
  ownerId: string | null;
  /** Naive local strings; `store.ts` resolves them against the show's zone. */
  mustArriveByLocal: string | null;
  receivingOpensLocal: string | null;
  pieces: number;
  weightLb: string | null;
  declaredValueCents: number | null;
  costCents: number | null;
  costCenterId: string;
  notes: string | null;
};

const CARRIERS = new Set(['ups', 'usps', 'fedex', 'dhl', 'other']);
const CONSIGNMENTS = new Set<Consignment>([
  'advance_warehouse',
  'show_site',
  'office',
  'direct',
]);

function localOrNull(
  date: string | null | undefined,
  time: string | null | undefined,
  what: string,
): string | null {
  const d = date?.trim() ?? '';
  const t = (time?.trim() || DEFAULT_CUTOFF_TIME).trim();
  if (!d) return null;
  if (!DATE.test(d)) throw new TeamError(`${what} needs a date, as YYYY-MM-DD.`);
  if (!TIME.test(t)) throw new TeamError(`${what} needs a time of day, as HH:MM.`);
  return `${d}T${t}:00`;
}

export function validateShipment(draft: ShipmentDraft): ValidatedShipment {
  const description = draft.description.trim();
  if (description.length < 2) throw new TeamError('A shipment needs a description of what is in it.');
  if (description.length > 200) throw new TeamError('Descriptions are capped at 200 characters.');

  const carrier = draft.carrier?.trim().toLowerCase() ?? '';
  if (!CARRIERS.has(carrier)) {
    throw new TeamError(`"${draft.carrier}" is not a carrier this app tracks.`);
  }
  if (!CONSIGNMENTS.has(draft.consignment)) {
    throw new TeamError(`"${draft.consignment}" is not a consignment this app understands.`);
  }

  const direction = draft.direction === 'return' ? 'return' : 'outbound';
  // `direct` is deliberately legal in both directions. It is the one consignment
  // that is not a rule about a show dock — a box to somebody's hotel on the way
  // in and a box mailed home from the booth are the same kind of thing, and
  // neither is freight going to or coming off a floor.
  if (direction === 'return' && draft.consignment !== 'office' && draft.consignment !== 'direct') {
    throw new TeamError(
      'A return shipment is consigned to the office, or sent direct to a person — it is what is ' +
        'coming back to us, not freight going to a floor.',
    );
  }
  if (direction === 'outbound' && draft.consignment === 'office') {
    throw new TeamError(
      'An outbound shipment goes to the advance warehouse, to show-site receiving, or direct to ' +
        'a hotel or a person. The first two are different rules about what "on time" means, not ' +
        'two addresses.',
    );
  }

  const mustArriveByLocal = localOrNull(
    draft.mustArriveOn,
    draft.mustArriveAt,
    'The receiving deadline',
  );
  const receivingOpensLocal = localOrNull(
    draft.receivingOpensOn,
    draft.receivingOpensAt,
    'Receiving opens',
  );

  if (draft.consignment === 'show_site' && !receivingOpensLocal) {
    throw new TeamError(
      'Show-site receiving needs the time the dock opens — usually move-in. Without it this row ' +
        'is only checked against the far edge of the window, and a crate that turns up two days ' +
        'early reads as comfortably on time right up until it is refused.',
    );
  }
  if (mustArriveByLocal && receivingOpensLocal && receivingOpensLocal >= mustArriveByLocal) {
    throw new TeamError(
      'Receiving opens on or after the deadline, which leaves no window at all. Check the two ' +
        'dates: the dock opens first, and freight has to be there before it closes.',
    );
  }

  const pieces = draft.pieces?.trim() ? Number(draft.pieces) : 1;
  if (!Number.isInteger(pieces) || pieces < 1 || pieces > 999) {
    throw new TeamError('Pieces has to be a whole number between 1 and 999.');
  }

  const weight = draft.weightLb?.trim() || null;
  if (weight !== null && !/^\d{1,6}(\.\d{1,2})?$/.test(weight)) {
    throw new TeamError('Weight is in pounds, as a number — e.g. 480 or 480.50.');
  }

  const declaredValueCents = optionalDecimalToCents(draft.declaredValue ?? null);
  if (declaredValueCents !== null && declaredValueCents < 0) {
    throw new TeamError('A declared value cannot be negative.');
  }
  const costCents = optionalDecimalToCents(draft.cost ?? null);
  if (costCents !== null && costCents < 0) throw new TeamError('A shipping cost cannot be negative.');

  const costCenterId = draft.costCenterId?.trim() ?? '';
  if (!costCenterId) {
    throw new TeamError(
      'A shipment needs a cost center. §4: every financial row carries one at creation, because ' +
        'a cost dimension added later permanently orphans the spend that came before it — and ' +
        'freight is one of the largest lines in a show’s true cost.',
    );
  }

  const trackingNumber = draft.trackingNumber?.trim().replace(/\s+/g, '') || null;
  if (trackingNumber && trackingNumber.length > 60) {
    throw new TeamError('That does not look like a tracking number.');
  }

  return {
    description,
    direction,
    consignment: draft.consignment,
    carrier,
    trackingNumber,
    ownerId: draft.ownerId?.trim() || null,
    mustArriveByLocal,
    receivingOpensLocal,
    pieces,
    weightLb: weight,
    declaredValueCents,
    costCents,
    costCenterId,
    notes: draft.notes?.trim() || null,
  };
}

/**
 * What deleting a shipment does *not* do, named on the screen before it happens.
 *
 * The same rule as un-staffing somebody and as cancelling a ticketed request:
 * the freight is with a carrier, and a row disappearing here changes nothing
 * about a pallet on a truck.
 */
export function describeDeletion(s: {
  trackingNumber: string | null;
  carrier: string;
  status: string;
}): string | null {
  if (!s.trackingNumber) return null;
  return (
    `This crate is with ${s.carrier.toUpperCase()} under ${s.trackingNumber} and its status is ` +
    `"${s.status.replace(/_/g, ' ')}". Deleting the record here does not cancel the shipment, ` +
    'recall the freight, or stop the billing — it only stops this app from watching it. Press ' +
    'again to delete anyway.'
  );
}

export { TeamError as ShippingError };
