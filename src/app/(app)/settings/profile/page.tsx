import { getActor } from '@/lib/auth/actor';
import { missingForTicket } from '@/lib/profile/edit';
import { getMyProfile } from '@/lib/profile/store';
import { Card, PageHeader } from '../../_components/ui';
import { ProfileForm } from './forms';

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
  const me = await getMyProfile(actor);
  const missing = missingForTicket(me);

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
        </ul>
      </Card>
    </div>
  );
}
