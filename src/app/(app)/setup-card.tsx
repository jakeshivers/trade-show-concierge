import type { SetupStep } from '@/lib/setup/checklist';
import { Card, LinkButton } from './_components/ui';
import { plural } from './_components/text';

/**
 * What this workspace still needs, on the first screen anybody sees.
 *
 * It renders only while something is outstanding and disappears on its own, and
 * it is **not dismissible**: a setup step somebody hid is a workspace that
 * silently stays broken, and the two states it produces — "configured" and
 * "configured except for the part that was dismissed" — look identical from
 * every other screen.
 *
 * Each row leads with the consequence rather than the chore, because that is
 * what gets it done, and a step the reader cannot perform still appears with the
 * person who can named beside it. Both rules are argued in `setup/checklist.ts`.
 */
export function SetupCard({ steps }: { steps: SetupStep[] }) {
  const mine = steps.filter((s) => s.mine).length;

  return (
    <Card
      title="Before this workspace works"
      subtitle={
        mine === steps.length
          ? `${plural(steps.length, 'thing', 'things')} to set up. This card goes away once they are done.`
          : `${plural(steps.length, 'thing', 'things')} to set up, ${mine} of them yours. This card goes away once they are done.`
      }
    >
      <ul className="divide-y divide-border">
        {steps.map((step) => (
          <li
            key={step.key}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{step.title}</p>
              <p className="mt-0.5 text-sm text-text-muted">{step.blocks}</p>
            </div>
            {step.mine ? (
              <LinkButton href={step.href} variant="primary">
                {step.cta}
              </LinkButton>
            ) : (
              <span className="shrink-0 py-1.5 text-sm text-text-muted">{step.whoCan}</span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
