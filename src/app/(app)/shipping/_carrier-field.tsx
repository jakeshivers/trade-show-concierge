'use client';

import { useState } from 'react';
import { identifyCarrier } from '@/lib/shipping/carrier';
import { Field, Input, Select } from '../_components/form-ui';

/**
 * The carrier and the tracking number, together, because one of them is written
 * inside the other.
 *
 * Both forms that take freight render this rather than a pair of loose controls,
 * for the reason `_present.tsx` exists: the moment two screens each read a
 * tracking number their own way, they can disagree about what it says and
 * nothing would catch it.
 *
 * The behaviour is three rules, and the last two are the ones worth arguing
 * about.
 *
 * **It fills the control, it does not decide the field.** `shipments.carrier`
 * picks which carrier account EasyPost is asked about, and a wrong one comes
 * back `NoRecord` — a crate the carrier has never heard of, which on the board
 * looks exactly like freight that has gone missing. So the inference moves a
 * `<select>` that a person is looking at and can change.
 *
 * **Once somebody has chosen, it stops choosing for them.** A control that keeps
 * re-deciding on every keystroke takes the choice away by outlasting it. After a
 * manual pick, nothing here touches the value again.
 *
 * **It says when it disagrees rather than going quiet.** Somebody who picked
 * USPS and then pasted a `1Z` number has almost certainly pasted into the wrong
 * row, and that is worth one sentence — the fix, though, is theirs, because the
 * only thing here that knows what the label says is them.
 */

const CARRIERS = [
  ['fedex', 'FedEx'],
  ['ups', 'UPS'],
  ['usps', 'USPS'],
  ['dhl', 'DHL'],
  ['other', 'Other / freight carrier'],
] as const;

export function CarrierAndTracking({
  defaultCarrier = 'fedex',
  defaultTracking = '',
  density = 'comfortable',
  trackingHint,
}: {
  defaultCarrier?: string;
  defaultTracking?: string;
  density?: 'compact' | 'comfortable';
  trackingHint?: React.ReactNode;
}) {
  const [tracking, setTracking] = useState(defaultTracking);
  const [carrier, setCarrier] = useState(defaultCarrier);
  const [chosenByHand, setChosenByHand] = useState(false);

  const guess = identifyCarrier(tracking);
  const inferred = guess.carrier !== null;
  // A disagreement is only interesting once somebody has actually made a choice
  // — before that the inference simply wins, so there is nothing to report.
  const disagrees = inferred && chosenByHand && guess.carrier !== carrier;
  const readFromNumber = inferred && !chosenByHand && guess.carrier === carrier;

  function onTracking(value: string) {
    setTracking(value);
    if (chosenByHand) return;
    const g = identifyCarrier(value);
    if (g.carrier !== null) setCarrier(g.carrier);
  }

  return (
    <>
      <Field
        label="Carrier"
        hint={
          readFromNumber ? (
            <span className="text-good">Read from the number — {guess.why}.</span>
          ) : disagrees ? (
            <span className="text-warn">
              That number looks like {label(guess.carrier!)} — {guess.why}. Left as you set it.
            </span>
          ) : undefined
        }
      >
        <Select
          name="carrier"
          density={density}
          value={carrier}
          onChange={(e) => {
            setCarrier(e.target.value);
            setChosenByHand(true);
          }}
        >
          {CARRIERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Tracking number"
        hint={
          inferred && 'checkDigitDisagrees' in guess && guess.checkDigitDisagrees ? (
            <span className="text-warn">
              UPS’s own check digit does not agree with the rest of this number — one character
              is probably mistyped. Saving it anyway is fine.
            </span>
          ) : inferred && 'note' in guess && guess.note ? (
            <span className="text-text-muted">{guess.note}</span>
          ) : (
            trackingHint
          )
        }
      >
        <Input
          name="trackingNumber"
          density={density}
          value={tracking}
          onChange={(e) => onTracking(e.target.value)}
          placeholder="1Z999AA10123456784"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
    </>
  );
}

function label(code: string): string {
  return CARRIERS.find(([v]) => v === code)?.[1] ?? code.toUpperCase();
}
