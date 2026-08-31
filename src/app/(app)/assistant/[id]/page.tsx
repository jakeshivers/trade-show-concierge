import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActor, ForbiddenError } from '@/lib/auth/actor';
import { getTranscript } from '@/lib/assistant/store';
import { selectAssistantModelOrNull } from '@/lib/assistant/provider';
import { Card, Empty, PageHeader } from '../../_components/ui';
import { AskForm } from '../ask-form';
import { DraftNotice, ScriptedBanner, ToolStepRow } from '../_present';

/**
 * One conversation.
 *
 * The transcript renders the tool steps beside the prose rather than behind it.
 * See `_present.tsx` for why: the paraphrase is the only part of this page that
 * can be confidently wrong, so the thing it was written from stays reachable on
 * the same screen.
 */

export const dynamic = 'force-dynamic';

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const actor = await getActor();

  let transcript;
  try {
    transcript = await getTranscript(actor, id);
  } catch (err) {
    // Somebody else's conversation and a conversation that does not exist are
    // the same 404 on purpose.
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }

  const model = selectAssistantModelOrNull();

  return (
    <div className="space-y-6">
      <PageHeader
        title={transcript.conversation.title}
        blurb={
          <Link href="/assistant" className="hover:underline">
            ← All conversations
          </Link>
        }
      />

      {transcript.conversation.provider === 'scripted' && <ScriptedBanner />}

      <div className="space-y-4">
        {transcript.entries.length === 0 && <Empty>Nothing said yet.</Empty>}
        {transcript.entries.map((entry) => {
          if (entry.kind === 'user') {
            return (
              <div key={entry.id} className="flex justify-end">
                <p className="max-w-2xl rounded-xl bg-brand/10 px-4 py-2.5 text-sm">
                  {entry.text}
                </p>
              </div>
            );
          }
          if (entry.kind === 'tool') {
            return <ToolStepRow key={entry.id} entry={entry} />;
          }
          return (
            <div key={entry.id} className="space-y-3">
              <Card>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{entry.text}</p>
              </Card>
              <DraftNotice
                travelRequestId={entry.draftTravelRequestId}
                lodgingId={entry.draftLodgingId}
              />
            </div>
          );
        })}
      </div>

      {'unavailable' in model ? (
        <Card title="Not configured">
          <p className="text-sm text-text-muted">{model.unavailable}</p>
        </Card>
      ) : (
        <Card>
          <AskForm conversationId={transcript.conversation.id} placeholder="Ask a follow-up…" />
        </Card>
      )}
    </div>
  );
}
