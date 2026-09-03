'use client';

import { useActionState } from 'react';
import { Field, Input, Message, Select, Submit } from '../../_components/form-ui';
import { GENDERS, GENDER_LABEL, HONORIFICS, SEAT_PREFERENCES } from '@/lib/profile/edit';
import { saveProfile } from './actions';

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

      <Submit pending={pending} busy="Saving…">Save</Submit>
      <Message state={state} />
    </form>
  );
}
