import Link from 'next/link';
import { getActor } from '@/lib/auth/actor';
import { listConversations } from '@/lib/assistant/store';
import { selectAssistantModelOrNull } from '@/lib/assistant/provider';
import { toolsFor } from '@/lib/assistant/access';
import { Card, Empty, PageHeader } from '../_components/ui';
import { AskForm } from './ask-form';
import { ScriptedBanner } from './_present';

/**
 * The concierge. SCOPE.md §10 step 15.
 *
 * §1's corollary is that for a Member this app should be almost invisible, and
 * this is the screen that tries to make that true: one box, and an answer that
 * would otherwise have been six tabs. The rest of the product is for the people
 * who plan shows; this is for the person who wants to know when their crate
 * lands and whether their flight still clears move-in.
 *
 * What it is not is a second data layer. Every answer here comes out of the same
 * store functions the other screens call, as the same actor, through the same
 * gates — see `src/lib/assistant/tools.ts`, which is where the access model
 * actually lives. Nothing on this page can see a row that `/shows` could not.
 */

export const metadata = { title: 'Assistant' };
export const dynamic = 'force-dynamic';

export default async function AssistantPage() {
  const actor = await getActor();
  const model = selectAssistantModelOrNull();
  const conversations = await listConversations(actor);
  const tools = toolsFor(actor);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Assistant"
        blurb={
          <>
            Ask about anything in this workspace, or describe a trip and have the request
            drafted. It reads what you can already read and drafts what you would otherwise
            type — it never books, buys, approves or confirms.
          </>
        }
      />

      {'unavailable' in model ? (
        <Card title="Not configured">
          <p className="text-sm text-text-muted">{model.unavailable}</p>
          <p className="mt-2 text-sm text-text-muted">
            There is no fallback here on purpose. A screen quietly answering from a keyword
            matcher would be indistinguishable, in prose, from one answering from a model
            reading live rows.
          </p>
        </Card>
      ) : (
        <>
          {model.choice.scripted && <ScriptedBanner />}
          <Card>
            <AskForm placeholder="Where is the MedTech crate? · Am I flying anywhere next month? · Get me to Vegas Tuesday morning, back Thursday night" />
          </Card>
        </>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Your conversations" subtitle="Private to you — see below.">
          {conversations.length === 0 ? (
            <Empty>
              No conversations yet. Ask something above — the answers are built from the same
              records the screens use, narrowed to what you can see.
            </Empty>
          ) : (
            <ul className="divide-y divide-border">
              {conversations.map((c) => (
                <li key={c.id} className="py-2">
                  <Link href={`/assistant/${c.id}`} className="text-sm hover:underline">
                    {c.title}
                  </Link>
                  <div className="text-xs text-text-muted">
                    {c.provider === 'scripted' ? 'scripted · ' : ''}
                    {c.updatedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-xs text-text-muted">
            Nobody else can read these, including an admin. Every result inside a transcript
            was fetched under <em>your</em> scope; a second reader would be reading rows a
            query narrowed for somebody else.
          </p>
        </Card>

        <Card
          title="What it can reach"
          subtitle="Each of these is a store function, called as you."
        >
          <ul className="grid gap-x-6 gap-y-1 text-xs text-text-muted sm:grid-cols-2">
            {tools.map((t) => (
              <li key={t.name} className="font-mono">
                {t.name}
                {t.kind === 'draft' && <span className="ml-1 font-sans not-italic">· draft</span>}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-text-muted">
            There is no tool that queries around you. A question about somebody else&rsquo;s
            room is not refused by a rule the model was told about — the row is never
            retrieved, because the query was narrowed before the assistant saw anything.
          </p>
        </Card>
      </div>
    </div>
  );
}
