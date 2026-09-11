'use client';

import { useActionState } from 'react';
import { Form, Message } from '../_components/form-ui';
import { answerFromBoard } from './actions';

/**
 * Heard from somebody, recorded from the board.
 *
 * The same control the show's Safety tab carries, and the same reasoning: an
 * answer is never the last word, so it stays available after somebody has
 * answered — a name that cannot be reopened is a name people work around by
 * starting a second roll call, which is the one thing answered by fewer people
 * than the first. And the wording is third-person for a colleague and
 * first-person for yourself, because relaying what somebody told you on the
 * phone and saying you are fine are different acts even though the permission
 * allows both.
 */
export function BoardAnswer({
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
  standing: 'ok' | 'needs_help' | null;
}) {
  const [state, action, pending] = useActionState(answerFromBoard, {});
  const first = name.split(' ')[0];
  return (
    <Form action={action} state={state} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="checkId" value={checkId} />
      <input type="hidden" name="userId" value={userId} />
      <input
        name="note"
        placeholder={isSelf ? 'Where are you?' : `What did ${first} say?`}
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
          {isSelf ? 'I am OK' : `${first} is OK`}
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
          Needs help
        </button>
      )}
      <Message state={state} />
    </Form>
  );
}
