import { getActor } from '@/lib/auth/actor';
import { missingForTicket } from '@/lib/profile/edit';
import { getMyLoyaltyAccounts, getMyProfile } from '@/lib/profile/store';
import { NoPolicyError, resolveTravelPolicy } from '@/lib/travel/policy-store';
import { Card, PageHeader } from '../../_components/ui';
import { LoyaltyAccounts, ProfileForm } from './forms';

/**
 * Your own traveler details — the screen this product spent twenty-four steps
 * without, and the second entry under Settings that is not admin-only.
 *
 * It exists because two shipped features depend on columns nothing could write.
 * `travel/passengers.ts` refuses to build a passenger without a date of birth
 * and a phone number, so the booking agent — the thing this whole product is
 * built around — throws `MissingTravelerDetailsError` at any real user and names
 * fields they had no way to supply. And §5o counts people with no phone number
 * apart, names them, and argues that the moment to look is a quiet Tuesday
 * because it is free to fix then; it was free to fix for everybody except the
 * person reading it. The seeded workspace filled both columns in directly, which
 * is exactly why neither gap ever showed up on a screen.
 *
 * It writes **your own row only** — see `profile/store.ts` for why that is a
 * rule rather than a missing feature.
 */
export default async function ProfilePage() {
  const actor = await getActor();
  const [me, loyalty] = await Promise.all([getMyProfile(actor), getMyLoyaltyAccounts(actor)]);
  const missing = missingForTicket(me);
  const carrier = await carrierPreferenceStanding(actor, me.preferredAirlines ?? []);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Your details"
        blurb="What goes on a ticket, and how somebody reaches you when a show is going wrong. Only you can change these — a date of birth typed by somebody else buys a real ticket that fails at the gate."
      />

      {/*
        Said before a request is filed rather than after it is refused. The list
        comes from `missingForTicket`, which mirrors `passengerForUser`'s own
        checks rather than making a second guess at what a ticket needs — two
        opinions on that is how a screen comes to say you are ready while the
        agent says you are not.
      */}
      {missing.length > 0 ? (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          No flight can be ticketed for you yet: we still need {missing.join(', ')}. The agent
          will search and price an itinerary without these, and refuse at the point of purchase
          — so it is worth filling in before you need a trip rather than during one.
        </p>
      ) : (
        <p className="rounded-md bg-good-soft px-3 py-2 text-sm text-good">
          Everything a carrier needs to issue you a ticket is on file.
        </p>
      )}

      <Card title="Traveler details">
        <ProfileForm profile={me} />
      </Card>

      {/*
        Said on the screen where the preference is typed, because both of these
        are silent otherwise. A carrier the org blocks will simply never win and
        look like the feature is broken; an unpriced allowance means the whole
        list is a tie-break, which is a legitimate state and an invisible one.
        The alternative — letting somebody type UA and wonder for a year — is
        the failure this codebase keeps naming.
      */}
      {carrier && (
        <p className="rounded-md bg-surface-muted px-3 py-2 text-sm text-text-muted">{carrier}</p>
      )}

      <Card
        title="Frequent flyer accounts"
        subtitle="Sent to the carrier when a fare is searched and again when a ticket is bought. One number per airline — retyping one corrects it."
      >
        {/*
          The honest sentence, and it is why this card has a blurb at all.
          Nothing in a search or an order response tells us whether the carrier
          recognised a number, so a saved row is a record that we passed it on
          and never a claim that miles are accruing. The failure of a mistyped
          number is a year of trips that quietly earned nothing, which nobody
          goes looking for — the same shape as the Salesforce join in §19.
        */}
        <p className="mb-4 rounded-md bg-surface-muted px-3 py-2 text-xs text-text-muted">
          We pass these to the airline; the airline never tells us whether it accepted one. A
          number saved here is not proof that miles are crediting — check your statement after
          the first trip.
        </p>
        <LoyaltyAccounts accounts={loyalty} />
      </Card>

      <Card title="What is not here">
        <ul className="space-y-1 text-sm text-text-muted">
          <li>
            <span className="text-text">Your role and cost center</span> are set by an admin,
            not by you — they decide what you may approve and where your spend lands.
          </li>
          <li>
            <span className="text-text">Your email</span> comes from how you sign in, and is
            what the notification transport resolves a destination from.
          </li>
          <li>
            <span className="text-text">Passport and visa details</span> are deliberately not
            collected. This app books flights; it does not hold travel documents.
          </li>
          <li>
            <span className="text-text">Hotel and car rental preferences</span> have nothing to
            act on them. This app records hotels rather than booking them, and car rental is out
            of scope — a preference nothing reads is a promise nothing keeps.
          </li>
        </ul>
      </Card>
    </div>
  );
}

/**
 * What the org's policy actually does with the carriers you listed.
 *
 * Reads the *resolved* policy for this person rather than the org's base layer,
 * because an override on their cost center is what would really apply — the same
 * resolution the agent runs. Returns null when there is nothing worth saying, and
 * swallows `NoPolicyError`: a workspace with no policy has a bigger problem, it
 * is already reported on `/settings/travel-policy`, and a profile page is not the
 * screen to raise it on.
 */
async function carrierPreferenceStanding(
  actor: Awaited<ReturnType<typeof getActor>>,
  preferred: string[],
): Promise<string | null> {
  if (preferred.length === 0) return null;
  let policy;
  try {
    ({ policy } = await resolveTravelPolicy(actor.orgId, { costCenterId: actor.costCenterId }));
  } catch (err) {
    if (err instanceof NoPolicyError) return null;
    throw err;
  }

  const blocked = preferred.filter((c) => policy.blockedAirlines.includes(c));
  const allowance = policy.personalCarrierAllowanceCents;

  const parts: string[] = [];
  if (blocked.length) {
    parts.push(
      `Your organization blocks ${blocked.join(', ')}, so ${blocked.length === 1 ? 'it' : 'they'} ` +
        'will never be chosen no matter what you list here.',
    );
  }
  parts.push(
    allowance && allowance > 0
      ? `Your organization will pay up to $${(allowance / 100).toFixed(2)} more to put you on ` +
        'one of these. Beyond that, the cheaper fare wins.'
      : 'Your organization has not priced a carrier preference, so this only breaks a tie ' +
        'between two fares that cost the same. An admin sets that on the travel policy.',
  );
  return parts.join(' ');
}
