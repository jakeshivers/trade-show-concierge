import Link from 'next/link';
import { getActor, canApprove } from '@/lib/auth/actor';
import { listRequests } from '@/lib/travel/queue';
import { selectProviderOrNull } from '@/lib/travel/provider';
import {
  Card,
  Empty,
  LinkButton,
  PageHeader,
} from '../_components/ui';
import { RequestRow } from './_components';

/**
 * My travel requests.
 *
 * The first screen over the spine steps 4–6 built. Everything on it — the
 * statuses, the fares, the standing of each offer — was already in the database;
 * what was missing was any way to see it that was not `pnpm booking:audit`.
 */
export default async function TravelPage() {
  const actor = await getActor();
  const [mine, provider] = await Promise.all([
    listRequests(actor, { scope: 'mine' }),
    Promise.resolve(selectProviderOrNull()),
  ]);

  const replayed = 'choice' in provider && provider.choice.replayed;

  return (
    <div className="space-y-6">
      <PageHeader
        title="My travel"
        blurb={
          <>
            Requests you opened or are flying on. An approver sees everyone&rsquo;s on the{' '}
            <Link href="/travel/approvals" className="underline">
              approvals queue
            </Link>
            .
          </>
        }
        action={<LinkButton href="/travel/new">New request</LinkButton>}
      />

      {'unavailable' in provider && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-xs text-warn">
          <strong>No flight provider is configured</strong>, so nothing can be searched. Requests
          can still be opened — they are yours, not the airline&rsquo;s. {provider.unavailable}
        </p>
      )}

      {replayed && (
        <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
          Offers come from the <code>recorded</code> provider — captured payloads replayed through
          the real normalizer. They are genuine past responses, not live availability, and nothing
          here can spend money.
        </p>
      )}

      <Card title={`Requests (${mine.length})`}>
        {mine.length === 0 ? (
          <Empty>
            You have no travel requests. Opening one records what you need; the agent searches,
            rules on it against policy, and either books it or puts it in front of an approver.
          </Empty>
        ) : (
          <ul>
            {mine.map((r) => (
              <RequestRow key={r.id} r={r} showTraveler={canApprove(actor)} />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
