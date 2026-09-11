'use client';

import { useActionState } from 'react';
import { answer, beginRollCall, endRollCall } from './actions';
import { Form, Message, QuietSubmit, Submit, Textarea } from '../../../_components/form-ui';

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
    <Form action={action} state={state} className="space-y-2">
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
          This asks everyone at the show to stop what they are doing and confirm they are all
          right. Use it sparingly — a second roll call gets answered by fewer people than the
          first.
        </span>
      </div>
      <Message state={state} />
    </Form>
  );
}

export function CloseRollCall({ showId, checkId }: { showId: string; checkId: string }) {
  const [state, action, pending] = useActionState(endRollCall, {});
  return (
    <Form action={action} state={state} className="inline-flex items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="checkId" value={checkId} />
      <QuietSubmit pending={pending}>Close it</QuietSubmit>
      <Message state={state} />
    </Form>
  );
}

export function AnswerFor({
  showId,
  checkId,
  userId,
  isSelf,
  name,
  standing,
}: {
  showId: string;
  checkId: string;
  userId: string;
  isSelf: boolean;
  name: string;
  /** What they have said so far, if anything. Null until somebody answers. */
  standing: 'ok' | 'needs_help' | null;
}) {
  const [state, action, pending] = useActionState(answer, {});
  const first = name.split(' ')[0];

  // An answer is never the last word. Responses are append-only and the roll
  // call reads the *latest* one, so somebody who said they need help and is then
  // reached is corrected by recording what they now say — not by editing or
  // deleting what they said before. For three steps this control was hidden the
  // moment anybody answered, which made "needs help" a one-way door on screen
  // while the store had always expected a second answer. A name that cannot be
  // reopened is a name somebody works around by starting a second roll call,
  // which is the one thing that gets answered by fewer people than the first.
  return (
    <Form action={action} state={state} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="userId" value={userId} />
      <input
        name="note"
        placeholder={
          standing
            ? isSelf
              ? 'What has changed?'
              : `What does ${first} say now?`
            : isSelf
              ? 'Where are you?'
              : `What did ${first} say?`
        }
        className="min-w-40 flex-1 rounded-md border border-border bg-panel px-2 py-1 text-sm"
      />
      {standing !== 'ok' && (
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
          {standing === 'needs_help'
            ? isSelf
              ? 'I’m OK now'
              : `${first} is OK now`
            : isSelf
              ? 'I’m OK'
              : `${first} is OK`}
        </button>
      )}
      {standing !== 'needs_help' && (
        <button
          type="submit"
          name="standing"
          value="needs_help"
          disabled={pending}
          className="rounded-md border border-bad bg-panel px-2 py-1 text-sm font-medium text-bad disabled:opacity-50"
        >
          {standing === 'ok' ? 'Actually, needs help' : 'Needs help'}
        </button>
      )}
      <Message state={state} />
    </Form>
  );
}
