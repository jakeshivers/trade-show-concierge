'use client';

import { useActionState } from 'react';
import type { RateCardRow } from '@/lib/drayage/store';
import type { DrayageEstimate, HandlingKind } from '@/lib/drayage/estimate';
import { BASIS_LABEL, DRAYAGE_BASES } from '@/lib/drayage/edit';
import { Badge, money } from '../../../_components/ui';
import { Field, Form, Input, Message, QuietSubmit, Select, Submit } from '../../../_components/form-ui';
import {
  confirmDrayageRateCard,
  recordCrateHandling,
  removeDrayageRateCard,
  saveDrayageRateCard,
} from './drayage-actions';

/**
 * The rate card, and the estimate it produces.
 *
 * The card is eight fields and one of them is load-bearing beyond all the
 * others: **basis has no pre-selected option.** A dropdown that opens on "round
 * trip" is a default, and reading an each-way card as round trip halves the
 * largest line on the show while reading it the other way doubles it. There is
 * no safe guess, so the form makes you answer.
 *
 * The estimate is rendered under it with its arithmetic showing — billable
 * pounds beside actual, hundredweight beside the rate — because the number's
 * whole claim is that it was computed rather than guessed, and a person checking
 * it against a real invoice needs the working.
 */

const HANDLING_LABEL: Record<HandlingKind, string> = {
  crated: 'Crated',
  uncrated: 'Not crated',
  unknown: 'Nobody has said',
};

export function RateCardForm({ showId, card }: { showId: string; card: RateCardRow | null }) {
  const [state, action, pending] = useActionState(saveDrayageRateCard, {});

  return (
    <Form action={action} state={state} className="space-y-3">
      <input type="hidden" name="showId" value={showId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="General contractor" hint="Freeman, GES, or whoever the show appointed.">
          <Input name="contractor" defaultValue={card?.contractor ?? ''} placeholder="Freeman" />
        </Field>
        <Field
          label="Minimum weight (lb)"
          hint="Almost always 200. It is what makes two small crates cost more than one big one."
        >
          <Input name="minimumLb" defaultValue={String(card?.minimumLb ?? 200)} required />
        </Field>
        <Field label="Advance warehouse, per 100 lb" hint="Blank if the card does not price it.">
          <Input
            name="advanceCwt"
            defaultValue={card?.advanceCwtCents ? (card.advanceCwtCents / 100).toFixed(2) : ''}
            placeholder="142.00"
          />
        </Field>
        <Field label="Direct to show site, per 100 lb" hint="Usually higher than the advance rate.">
          <Input
            name="showSiteCwt"
            defaultValue={card?.showSiteCwtCents ? (card.showSiteCwtCents / 100).toFixed(2) : ''}
            placeholder="175.00"
          />
        </Field>
      </div>

      <Field
        label="How the card charges"
        hint="The manual says which. There is no default here on purpose: guessing round trip on an each-way card halves this show’s biggest line, and guessing the other way doubles it."
      >
        <Select name="basis" defaultValue={card?.basis ?? ''} required>
          <option value="" disabled>
            Read it off the manual…
          </option>
          {DRAYAGE_BASES.map((b) => (
            <option key={b} value={b}>
              {BASIS_LABEL[b]}
            </option>
          ))}
        </Select>
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Special handling surcharge (%)"
          hint="For freight that is not crated. Leave blank if the card is silent — blank is not zero, and an uncrated crate under a silent card is reported as a gap rather than billed at par."
        >
          <Input
            name="specialHandlingPct"
            defaultValue={card?.specialHandlingPct ?? ''}
            placeholder="30"
          />
        </Field>
        <Field label="Overtime surcharge (%)" hint="For receiving outside straight time.">
          <Input name="overtimePct" defaultValue={card?.overtimePct ?? ''} placeholder="25" />
        </Field>
      </div>

      <Field label="Where in the manual" hint="So the next person can check it without hunting.">
        <Input
          name="sourceNote"
          defaultValue={card?.sourceNote ?? ''}
          placeholder="Section 7 — material handling rates"
        />
      </Field>

      <div className="flex items-center gap-2">
        <Submit pending={pending} busy="Saving…">
          {card ? 'Update the card' : 'Save the card'}
        </Submit>
        <span className="text-xs text-text-muted">
          Saving withdraws any confirmation — a confirmation is about the numbers that were
          there when somebody looked.
        </span>
      </div>
      <Message state={state} />
    </Form>
  );
}

export function RateCardStanding({ showId, card }: { showId: string; card: RateCardRow }) {
  const [confirmState, confirmAction, confirming] = useActionState(confirmDrayageRateCard, {});
  const [removeState, removeAction, removing] = useActionState(removeDrayageRateCard, {});

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {card.confirmedAt ? (
        <Badge tone="good">Checked against this year’s manual</Badge>
      ) : (
        <Badge tone="warn">Not checked against this year’s manual</Badge>
      )}
      <Form action={confirmAction} state={confirmState}>
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="confirmed" value={card.confirmedAt ? 'false' : 'true'} />
        <QuietSubmit pending={confirming}>
          {card.confirmedAt ? 'Withdraw' : 'Confirm it'}
        </QuietSubmit>
      </Form>
      <Form action={removeAction} state={removeState}>
        <input type="hidden" name="showId" value={showId} />
        <QuietSubmit pending={removing}>Remove the card</QuietSubmit>
      </Form>
      <Message state={confirmState} />
      <Message state={removeState} />
    </div>
  );
}

/** How a crate is packed. Anybody may set this — see `lib/drayage/access.ts`. */
export function HandlingControl({
  showId,
  shipmentId,
  handling,
}: {
  showId: string;
  shipmentId: string;
  handling: HandlingKind;
}) {
  const [state, action, pending] = useActionState(recordCrateHandling, {});
  return (
    <Form action={action} state={state} className="flex items-center gap-1">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="shipmentId" value={shipmentId} />
      <Select name="handling" defaultValue={handling} aria-label="How this crate is packed">
        {(Object.keys(HANDLING_LABEL) as HandlingKind[]).map((h) => (
          <option key={h} value={h}>
            {HANDLING_LABEL[h]}
          </option>
        ))}
      </Select>
      <QuietSubmit pending={pending}>Save</QuietSubmit>
      <Message state={state} />
    </Form>
  );
}

/** The estimate, with its working shown. */
export function DrayageEstimateCard({ estimate }: { estimate: DrayageEstimate }) {
  return (
    <div>
      <p className="text-sm">
        {estimate.total.ok ? (
          <>
            <span className="text-lg font-semibold">
              {estimate.isFloor ? 'At least ' : ''}
              {money(estimate.total.cents)}
            </span>{' '}
            <span className="text-text-muted">
              estimated. Not in the show’s cost total — nobody has been billed it yet.
            </span>
          </>
        ) : (
          <span className="text-text-muted">{estimate.total.reason}</span>
        )}
      </p>

      {estimate.perShipment.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {estimate.perShipment.map((p) => (
            <li key={p.shipmentId} className="flex flex-wrap gap-2">
              <span className="w-20 shrink-0 text-right font-medium tabular-nums">
                {money(p.cents)}
              </span>
              <span className="w-40 shrink-0 text-text-muted tabular-nums">
                {p.hundredweight} CWT ({p.billableLb} lb billable)
              </span>
              <span>{p.description}</span>
              {p.specialHandlingCents > 0 && (
                <span className="text-text-muted">
                  incl. {money(p.specialHandlingCents)} special handling
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {(estimate.gaps.length > 0 || estimate.coveredByRoundTrip > 0) && (
        <ul className="mt-3 space-y-1 text-xs text-text-muted">
          {estimate.gaps.map((g, i) => (
            <li key={i}>· {g.what}</li>
          ))}
          {estimate.coveredByRoundTrip > 0 && (
            <li>
              · {estimate.coveredByRoundTrip} return leg
              {estimate.coveredByRoundTrip === 1 ? '' : 's'} already paid for on the way in —
              this card charges round trip
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
