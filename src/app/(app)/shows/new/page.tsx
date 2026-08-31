import { getActor } from '@/lib/auth/actor';
import {
  Card,
  PageHeader,
} from '../../_components/ui';
import { IntakeForm } from './form';

/**
 * Propose a show.
 *
 * Anyone may propose; only an admin commits or declines. That asymmetry is the
 * point of intake — the person who knows a show is worth doing is usually not the
 * person who signs the contract, and a proposal queue is cheaper than an argument
 * in a thread.
 */
export default async function NewShowPage() {
  await getActor();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Propose a show"
        blurb={
          <>
            This creates a <strong>prospect</strong>, not a commitment. An admin decides, and both
          the yes and the no are recorded with their reasoning.
          </>
        }
      />

      <Card>
        <IntakeForm defaultTimezone="America/Chicago" />
      </Card>
    </div>
  );
}
