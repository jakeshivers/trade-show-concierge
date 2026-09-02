'use client';

import { useActionState } from 'react';
import { answer, beginRollCall, endRollCall } from './actions';
import { Message, QuietSubmit, Submit, Textarea } from '../../../_components/form-ui';

/**
 * The controls, and one that is deliberately absent.
 *
 * **There is no "mark everyone safe".** It is the obvious button, it is what
 * clears a board in one press, and it is the only control here that could
 * produce a complete headcount without anybody having spoken to anybody. Every
 * name is closed one at a time, by somebody, with their name on it.
 */

export function StartRollCall({ showId }: { showId: string }) {
  const [state, action, pending] = useActionState(beginRollCall, {});
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="showId" value={showId} />
      <Textarea
        name="note"
        rows={2}
        placeholder="What happened? e.g. Fire alarm in Hall B — confirm you are out of the building."
      />
      <div className="flex items-center gap-3">
        <Submit pending={pending} busy="Starting…">
          Start a roll call
        </Submit>
        <span className="text-xs text-text-muted">
          This asks everybody at the show to stop and answer. A second one gets answered by
          fewer people than the first.
        </span>
      </div>
      <Message state={state} />
    </form>
  );
}

export function CloseRollCall({ showId, checkId }: { showId: string; checkId: string }) {
  const [state, action, pending] = useActionState(endRollCall, {});
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="checkId" value={checkId} />
      <QuietSubmit pending={pending}>Close it</QuietSubmit>
      <Message state={state} />
    </form>
  );
}

export function AnswerFor({
  showId,
  checkId,
  userId,
  isSelf,
  name,
}: {
  showId: string;
  checkId: string;
  userId: string;
  isSelf: boolean;
  name: string;
}) {
  const [state, action, pending] = useActionState(answer, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="userId" value={userId} />
      <input
        name="note"
        placeholder={isSelf ? 'Where are you?' : `What did ${name.split(' ')[0]} say?`}
        className="min-w-40 flex-1 rounded-md border border-border bg-panel px-2 py-1 text-sm"
      />
      <button
        type="submit"
        name="standing"
        value="ok"
        disabled={pending}
        className="rounded-md border border-border bg-panel px-2 py-1 text-sm font-medium disabled:opacity-50"
      >
        {/*
          Third person when it is somebody else, first person when it is you.
          The UI-rework's §2a correction: a component given only a boolean cannot
          tell "I am fine" apart from "he told me he is fine", and those are
          different acts even though the permission allows both.
        */}
        {isSelf ? 'I’m OK' : `${name.split(' ')[0]} is OK`}
      </button>
      <button
        type="submit"
        name="standing"
        value="needs_help"
        disabled={pending}
        className="rounded-md border border-bad bg-panel px-2 py-1 text-sm font-medium text-bad disabled:opacity-50"
      >
        Needs help
      </button>
      <Message state={state} />
    </form>
  );
}
