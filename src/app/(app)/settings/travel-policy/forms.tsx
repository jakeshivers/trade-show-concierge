'use client';

import { useActionState } from 'react';
import { CABINS, CABIN_LABEL } from '@/lib/travel/policy-edit';
import { Field, Form, Input, Message, Select, Submit } from '../../_components/form-ui';
import { savePolicy } from './actions';

type Live = {
  label: string | null;
  maxAirfareDomesticCents: number | null;
  maxAirfareInternationalCents: number | null;
  autoApproveUnderCents: number | null;
  denyOverCents: number | null;
  maxCabinDomestic: string | null;
  maxCabinInternational: string | null;
  premiumCabinAllowedOverHours: number | null;
  minAdvanceBookingDays: number | null;
  maxStops: number | null;
  minConnectionMinutes: number | null;
  arrivalBufferHoursBeforeMoveIn: number | null;
  nonRefundableAllowedUnderCents: number | null;
  maxAcceptableRefundPenaltyCents: number | null;
  preferredAirlines: string[] | null;
  preferredCarrierAllowanceCents: number | null;
  personalCarrierAllowanceCents: number | null;
  blockedAirlines: string[] | null;
  maxHotelNightlyRateCents: number | null;
  perShowTravelBudgetCents: number | null;
  requireCreditFirst: boolean | null;
} | null;

/** Cents back into the decimal string somebody typed. Blank stays blank. */
function dollars(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}
function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '' : String(n);
}

/**
 * The org's base travel policy.
 *
 * Every field is optional and **blank means "no rule"** rather than zero, which
 * is why nothing here is pre-filled with a default: a zero fare cap and an
 * absent one are opposite instructions, and the policy engine already
 * distinguishes them (`policy-store.ts`'s null-versus-undefined rule). The form
 * is seeded from the live version so saving without touching anything produces
 * an identical new version rather than wiping the policy.
 */
export function PolicyForm({ live }: { live: Live }) {
  const [state, action, pending] = useActionState(savePolicy, {});
  return (
    <Form action={action} state={state} className="space-y-6">
      <Field label="What changed" hint="Optional. Shown beside this version in the history below.">
        <Input name="label" density="comfortable" placeholder="Raised domestic cap for 2027" />
      </Field>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Spend</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Domestic fare cap" hint="Blank means no cap.">
            <Input name="maxAirfareDomestic" density="comfortable"
              defaultValue={dollars(live?.maxAirfareDomesticCents)} placeholder="850.00" />
          </Field>
          <Field label="International fare cap">
            <Input name="maxAirfareInternational" density="comfortable"
              defaultValue={dollars(live?.maxAirfareInternationalCents)} placeholder="2400.00" />
          </Field>
          <Field
            label="Auto-approve under"
            hint="The agent books this itself. Above it, a person approves an amount."
          >
            <Input name="autoApproveUnder" density="comfortable"
              defaultValue={dollars(live?.autoApproveUnderCents)} placeholder="600.00" />
          </Field>
          <Field
            label="Deny over"
            hint="An absolute ceiling. Nothing above it is bookable, with or without approval."
          >
            <Input name="denyOver" density="comfortable"
              defaultValue={dollars(live?.denyOverCents)} placeholder="3000.00" />
          </Field>
          <Field label="Per-show travel budget">
            <Input name="perShowTravelBudget" density="comfortable"
              defaultValue={dollars(live?.perShowTravelBudgetCents)} />
          </Field>
          <Field label="Hotel nightly cap" hint="Recorded, not enforced — this app books no hotels.">
            <Input name="maxHotelNightlyRate" density="comfortable"
              defaultValue={dollars(live?.maxHotelNightlyRateCents)} />
          </Field>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Cabin</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Domestic ceiling">
            <Select name="maxCabinDomestic" density="comfortable"
              defaultValue={live?.maxCabinDomestic ?? ''}>
              <option value="">No rule</option>
              {CABINS.map((c) => <option key={c} value={c}>{CABIN_LABEL[c]}</option>)}
            </Select>
          </Field>
          <Field label="International ceiling">
            <Select name="maxCabinInternational" density="comfortable"
              defaultValue={live?.maxCabinInternational ?? ''}>
              <option value="">No rule</option>
              {CABINS.map((c) => <option key={c} value={c}>{CABIN_LABEL[c]}</option>)}
            </Select>
          </Field>
          <Field label="Premium allowed over (hours)" hint="Flight time past which the ceiling lifts.">
            <Input name="premiumCabinAllowedOverHours" density="comfortable"
              defaultValue={num(live?.premiumCabinAllowedOverHours)} placeholder="6" />
          </Field>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Schedule</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Minimum advance booking (days)">
            <Input name="minAdvanceBookingDays" density="comfortable"
              defaultValue={num(live?.minAdvanceBookingDays)} placeholder="14" />
          </Field>
          <Field label="Maximum stops">
            <Input name="maxStops" density="comfortable" defaultValue={num(live?.maxStops)} placeholder="1" />
          </Field>
          <Field label="Minimum connection (minutes)">
            <Input name="minConnectionMinutes" density="comfortable"
              defaultValue={num(live?.minConnectionMinutes)} placeholder="45" />
          </Field>
          <Field
            label="Arrival buffer before move-in (hours)"
            hint="The rule the flight tracker re-checks against live times, and the only one that speaks after purchase."
          >
            <Input name="arrivalBufferHoursBeforeMoveIn" density="comfortable"
              defaultValue={num(live?.arrivalBufferHoursBeforeMoveIn)} placeholder="4" />
          </Field>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Fare rules and carriers</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Non-refundable allowed under">
            <Input name="nonRefundableAllowedUnder" density="comfortable"
              defaultValue={dollars(live?.nonRefundableAllowedUnderCents)} />
          </Field>
          <Field label="Acceptable refund penalty">
            <Input name="maxAcceptableRefundPenalty" density="comfortable"
              defaultValue={dollars(live?.maxAcceptableRefundPenaltyCents)} />
          </Field>
          <Field label="Preferred airlines" hint="Two-letter IATA codes: AA UA DL. Not names.">
            <Input name="preferredAirlines" density="comfortable"
              defaultValue={(live?.preferredAirlines ?? []).join(' ')} />
          </Field>
          <Field label="Blocked airlines">
            <Input name="blockedAirlines" density="comfortable"
              defaultValue={(live?.blockedAirlines ?? []).join(' ')} />
          </Field>
        </div>
        {/*
          The only two fields on this page that let the agent spend *more*. Every
          other number here is a ceiling, so a typo makes the policy looser and
          something else catches it; a slipped decimal here buys a dearer fare
          because of a carrier list. `policy-edit.ts` caps them separately and
          says so, and blank is a real answer rather than a missing one. They
          stack — an offer that satisfies both lists earns both — which is what
          the sentence under them says out loud.
        */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Preferred carrier allowance"
            hint="How much extra the agent may pay to stay on one of the preferred airlines above. Blank makes the list advisory only — recorded on the audit, with no effect on which fare wins."
          >
            <Input name="preferredCarrierAllowance" density="comfortable"
              defaultValue={dollars(live?.preferredCarrierAllowanceCents)} placeholder="blank — tie-break only" />
          </Field>
          <Field
            label="Personal carrier allowance"
            hint="The same, for an airline the traveler listed on their own profile."
          >
            <Input name="personalCarrierAllowance" density="comfortable"
              defaultValue={dollars(live?.personalCarrierAllowanceCents)} placeholder="blank — tie-break only" />
          </Field>
        </div>
        <p className="text-xs text-text-muted">
          These two stack: a fare on a carrier the company prefers <em>and</em> the traveler
          asked for earns both, so the most the agent will ever pay over the cheapest allowed
          fare is the sum of them. Neither can deny a fare, send one for approval, or move one
          past a fare that needs approval — that limit is enforced in the ranking code, not by
          keeping these numbers small.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="requireCreditFirst" defaultChecked={live?.requireCreditFirst ?? false}
            className="rounded border-border" />
          Spend unused ticket credits before buying a new fare
        </label>
      </section>

      <Submit pending={pending} busy="Saving…">Save as a new version</Submit>
      <Message state={state} />
    </Form>
  );
}
