import { getActor, isAdmin } from '@/lib/auth/actor';
import { listPolicyLayers, resolveTravelPolicy, NoPolicyError } from '@/lib/travel/policy-store';
import { Badge, Card, Empty, PageHeader } from '../../_components/ui';
import { PolicyForm } from './forms';

/**
 * The rules the booking agent enforces — and, until now, the ones an admin could
 * not set.
 *
 * `SCOPE.md` opens by describing this product as *"a policy-governed agent that
 * purchases flights within admin-defined spend and schedule constraints"*. The
 * engine is pure, deterministic and has 47 tests; the layering and versioning
 * are built; `policy/validate.ts` has carried a comment since step 3 saying it
 * exists for this editor. `travel_policies` was written in exactly one place:
 * `scripts/seed.ts`. So a real organization had no policy, and the agent's
 * answer to that is `NoPolicyError` — it refuses to search at all.
 *
 * Only the **org base layer** is editable here. Cost-center, role and show
 * overrides resolve correctly and are listed below read-only, because an
 * override that blanks a spend limit by omission is the accident the
 * null-versus-undefined rule guards against and the editing UI for it needs to
 * make that distinction visible rather than inherit it silently.
 */

export const metadata = { title: 'Travel policy' };
export const dynamic = 'force-dynamic';

export default async function TravelPolicyPage() {
  const actor = await getActor();
  if (!isAdmin(actor)) {
    return (
      <Empty>
        The travel policy decides what the booking agent may spend on your behalf, so only an
        admin changes it. What it decided about any one trip is on that request’s audit trail.
      </Empty>
    );
  }

  const layers = await listPolicyLayers(actor);
  const live = layers.find((l) => l.scope === 'org' && l.supersededAt === null) ?? null;
  const overrides = layers.filter((l) => l.scope !== 'org' && l.supersededAt === null);
  const history = layers.filter((l) => l.supersededAt !== null);

  let resolvedNote: string;
  try {
    const r = await resolveTravelPolicy(actor.orgId, {});
    resolvedNote = `Resolved from ${r.layers.length} layer${r.layers.length === 1 ? '' : 's'}.`;
  } catch (err) {
    resolvedNote =
      err instanceof NoPolicyError
        ? 'There is no policy, so the agent refuses to search at all.'
        : 'The policy could not be resolved.';
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Travel policy"
        blurb="What the booking agent may spend, which cabins it may buy, and how late a flight may land. It is deterministic — the agent never decides any of this, it applies it and records which rule bound each decision."
      />

      {!live && (
        <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          This organization has no travel policy, so the agent cannot search or book anything —
          it refuses rather than guessing at a limit. Set the base layer below.
        </p>
      )}

      <Card title={live ? `Base policy — version ${live.version}` : 'Base policy'} subtitle={resolvedNote}>
        <PolicyForm live={live} />
      </Card>

      {overrides.length > 0 && (
        <Card
          title="Overrides"
          subtitle="Layers that merge over the base for a cost center, a role or one show. Not editable here yet — a blank on an override means “this layer says nothing”, not “no limit”, and that distinction needs to be visible in the form before it can be typed into one."
        >
          <ul className="space-y-1 text-sm">
            {overrides.map((o) => (
              <li key={o.id} className="flex flex-wrap items-baseline gap-2">
                <Badge tone="neutral">{o.scope}</Badge>
                <span className="font-mono text-xs">{o.scopeRef}</span>
                <span className="text-text-muted">{o.label ?? 'no label'}</span>
                <span className="ml-auto text-xs text-text-muted">v{o.version}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Earlier versions"
        subtitle="Kept, never edited in place. Every booking already made was judged against the numbers that were live at the time, and rewriting them would make an audit trail say “within policy” about a policy that no longer exists."
      >
        {history.length === 0 ? (
          <Empty>No superseded versions yet.</Empty>
        ) : (
          <ul className="space-y-1 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">v{h.version}</span>
                <Badge tone="neutral">{h.scope}</Badge>
                <span className="text-text-muted">{h.label ?? 'no label'}</span>
                <span className="ml-auto text-xs text-text-muted">
                  replaced {h.supersededAt?.toLocaleDateString('en-US')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
