'use client';

import { useActionState } from 'react';
import { Field, Input, Message, QuietSubmit, Select, Submit } from '../../_components/form-ui';
import { GENDERS, GENDER_LABEL, HONORIFICS, SEAT_PREFERENCES } from '@/lib/profile/edit';
import { deleteLoyaltyAccount, saveLoyaltyAccount, saveProfile } from './actions';

const HONORIFIC_LABEL: Record<string, string> = {
  mr: 'Mr', ms: 'Ms', mrs: 'Mrs', miss: 'Miss', dr: 'Dr',
};
const SEAT_LABEL: Record<string, string> = {
  aisle: 'Aisle', window: 'Window', no_preference: 'No preference',
};

export function ProfileForm({
  profile,
}: {
  profile: {
    fullName: string;
    phone: string | null;
    bornOn: string | null;
    honorific: string | null;
    gender: string | null;
    knownTravelerNumber: string | null;
    seatPreference: string | null;
    homeAirport: string | null;
    preferredAirlines: string[] | null;
  };
}) {
  const [state, action, pending] = useActionState(saveProfile, {});
  return (
    <form action={action} className="space-y-4">
      <Field label="Full legal name" hint="As printed on the ID you travel with, not a nickname.">
        <Input name="fullName" defaultValue={profile.fullName} density="comfortable" required />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Phone"
          hint="With the country code. A roll call dials this, and so does the airline."
        >
          <Input
            name="phone"
            defaultValue={profile.phone ?? ''}
            density="comfortable"
            placeholder="+1 415 555 0101"
          />
        </Field>
        <Field
          label="Date of birth"
          hint="Required to issue a ticket. A wrong one is accepted by the carrier and refused at the gate."
        >
          {/*
            A plain date input rather than `ZonedDateTime`: a birthday is a
            calendar date, not an instant, and has no time zone to be read in.
            `passengers.ts` makes the same point where it hands the string to
            the provider without going through a Date.
          */}
          <Input
            type="date"
            name="bornOn"
            defaultValue={profile.bornOn ?? ''}
            density="comfortable"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Title">
          <Select name="honorific" defaultValue={profile.honorific ?? ''} density="comfortable">
            <option value="">Not recorded</option>
            {HONORIFICS.map((h) => (
              <option key={h} value={h}>{HONORIFIC_LABEL[h]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Gender" hint="What the carrier asks for, not a description of you.">
          <Select name="gender" defaultValue={profile.gender ?? ''} density="comfortable">
            <option value="">Not recorded</option>
            {GENDERS.map((g) => (
              <option key={g} value={g}>{GENDER_LABEL[g]}</option>
            ))}
          </Select>
        </Field>
        <Field label="Seat preference">
          <Select
            name="seatPreference"
            defaultValue={profile.seatPreference ?? ''}
            density="comfortable"
          >
            <option value="">Not recorded</option>
            {SEAT_PREFERENCES.map((sp) => (
              <option key={sp} value={sp}>{SEAT_LABEL[sp]}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Known Traveler Number"
          hint="TSA PreCheck or Global Entry. Optional, and passed to the carrier when present."
        >
          <Input
            name="knownTravelerNumber"
            defaultValue={profile.knownTravelerNumber ?? ''}
            density="comfortable"
          />
        </Field>
        <Field
          label="Home airport"
          hint="The three-letter IATA code you usually fly out of. It fills in “From” on a new travel request; you can type over it any time."
        >
          <Input
            name="homeAirport"
            defaultValue={profile.homeAirport ?? ''}
            density="comfortable"
            maxLength={3}
            placeholder="ORD"
            className="uppercase"
          />
        </Field>
      </div>

      <Field
        label="Preferred airlines"
        hint="Two-letter codes, separated by spaces — “UA DL”. A preference, never a rule: it moves an offer among the ones policy already allows and can never deny a fare or send one for approval."
      >
        <Input
          name="preferredAirlines"
          defaultValue={(profile.preferredAirlines ?? []).join(' ')}
          density="comfortable"
          placeholder="UA DL"
          className="uppercase"
        />
      </Field>

      <Submit pending={pending} busy="Saving…">Save</Submit>
      <Message state={state} />
    </form>
  );
}


/**
 * Frequent-flyer numbers.
 *
 * A separate form from the details above, and not because the page ran out of
 * room: adding a number and correcting a date of birth are different acts with
 * different consequences, and a single Save that did both would make one of them
 * invisible. It is also a list, and a list of rows does not round-trip through a
 * single `useActionState` without inventing an encoding for it.
 *
 * The sentence on the card is the load-bearing part. This app hands the number
 * to the carrier and gets nothing back that says whether it was recognised, so a
 * saved row is a claim we passed it on and never a claim it worked.
 */
export function LoyaltyAccounts({
  accounts,
}: {
  accounts: { id: string; airlineCode: string; accountNumber: string }[];
}) {
  const [state, action, pending] = useActionState(saveLoyaltyAccount, {});
  const [removeState, removeAction] = useActionState(deleteLoyaltyAccount, {});

  return (
    <div className="space-y-4">
      {accounts.length === 0 ? (
        <p className="text-sm text-text-muted">
          No accounts on file. Any flight booked for you earns nothing until one is.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {accounts.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-4 px-3 py-2">
              <span className="text-sm">
                <span className="font-medium">{a.airlineCode}</span>
                <span className="ml-3 font-mono text-text-muted">{a.accountNumber}</span>
              </span>
              <form action={removeAction}>
                <input type="hidden" name="id" value={a.id} />
                <QuietSubmit>Remove</QuietSubmit>
              </form>
            </li>
          ))}
        </ul>
      )}
      <Message state={removeState} />

      <form action={action} className="flex flex-wrap items-end gap-3">
        <Field label="Airline">
          <Input
            name="airlineCode"
            required
            maxLength={2}
            placeholder="DL"
            density="comfortable"
            className="w-20 uppercase"
          />
        </Field>
        <Field label="Membership number">
          <Input name="accountNumber" required density="comfortable" placeholder="1234567890" />
        </Field>
        <Submit pending={pending} busy="Saving…">
          Add
        </Submit>
      </form>
      <Message state={state} />
    </div>
  );
}
