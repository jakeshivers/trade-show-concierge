'use client';

import { useActionState, useState } from 'react';
import {
  changeStatus,
  createTask,
  removeTask,
  seedFromTemplate,
  updateTask,
} from './actions';
import { Badge, Button } from '../../../_components/ui';
import { MAX_WEIGHT, MIN_NOTE, TASK_CATEGORIES } from '@/lib/readiness/edit';
import type { ChecklistEntry } from '@/lib/readiness/store';
import type { ChecklistTemplate } from '@/lib/readiness/templates';
import type { FormState } from '../../../_components/form';
import { Message, QuietSubmit, Submit } from '../../../_components/form-ui';
import { zonedDateInput } from '@/lib/datetime/zoned';

/**
 * The writable half of the readiness tab.
 *
 * One rule shapes all of it: **a control that would be refused is not rendered,
 * and where that could be mistaken for a missing feature, the reason is written
 * next to the gap.** A Member sees their own tasks' status controls and no Skip
 * option, with a line saying why skipping belongs to whoever runs the show —
 * because "the button isn't there" and "the button is broken" look identical
 * otherwise. The server refuses regardless; this is legibility, not the control.
 */

const CATEGORY_LABEL = (c: string) => c.replace('_', ' ');

/* ------------------------------ status control ----------------------------- */

const PROGRESS: { value: string; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'complete', label: 'Complete' },
];

export function StatusControl({
  showId,
  entry,
  maySkip,
}: {
  showId: string;
  entry: ChecklistEntry;
  maySkip: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(changeStatus, {});
  // Blocked and skipped need a written reason, so the note box appears when one
  // of those is chosen rather than sitting there empty for every other move.
  const [next, setNext] = useState(entry.task.status);
  const needsNote = next === 'blocked' || next === 'skipped';

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="showId" value={showId} />
      <input type="hidden" name="taskId" value={entry.task.id} />
      <select
        name="status"
        value={next}
        onChange={(e) => setNext(e.target.value as typeof next)}
        className="rounded-md border border-border-strong bg-panel px-2 py-1 text-xs"
      >
        {PROGRESS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {(maySkip || entry.task.status === 'skipped') && <option value="skipped">Skipped</option>}
      </select>

      {needsNote && (
        <input
          name="note"
          required
          minLength={MIN_NOTE}
          defaultValue={entry.task.statusNote ?? ''}
          placeholder={next === 'skipped' ? 'Why is this being skipped?':'Blocked on what?'}
          className="min-w-56 flex-1 rounded-md border border-border-strong bg-panel px-2 py-1 text-xs"
        />
      )}

      <Submit disabled={pending || next === entry.task.status}>Save</Submit>
      <Message state={state} className="w-full" />
    </form>
  );
}

/* --------------------------------- add task -------------------------------- */

export function AddTaskForm({
  showId,
  people,
}: {
  showId: string;
  people: { id: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(createTask, {});

  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">Add a task</summary>
      <form action={action} className="mt-3 grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="showId" value={showId} />
        <Field label="Title" className="sm:col-span-2">
          <input name="title" required minLength={3} className={INPUT} />
        </Field>
        <Field label="Category">
          <select name="category" className={INPUT} defaultValue="booth">
            {TASK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`Weight (1–${MAX_WEIGHT})`} hint="3 means the show does not happen without it.">
          <input type="number" name="weight" min={1} max={MAX_WEIGHT} defaultValue={1} className={INPUT} />
        </Field>
        <Field label="Due" hint="Read as 5pm in the show’s own time zone.">
          <input type="date" name="dueOn" className={INPUT} />
        </Field>
        <Field label="Owner" hint="Leave unassigned rather than guessing.">
          <select name="assigneeId" className={INPUT} defaultValue="">
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <textarea name="description" rows={2} className={INPUT} />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            Add task
          </Button>
          <Message state={state} density="comfortable" className="mt-2" />
        </div>
      </form>
    </details>
  );
}

/* -------------------------------- edit task -------------------------------- */

export function EditTaskForm({
  showId,
  timezone,
  entry,
  people,
}: {
  showId: string;
  /** The show's zone — the due-date input is read and written in it. */
  timezone: string;
  entry: ChecklistEntry;
  people: { id: string; fullName: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateTask, {});
  const [del, delAction, deleting] = useActionState<FormState, FormData>(removeTask, {});
  const { task } = entry;

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-text-muted hover:text-text">
        Edit
      </summary>
      <form action={action} className="mt-2 grid gap-2 sm:grid-cols-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="taskId" value={task.id} />
        <Field label="Title" className="sm:col-span-2">
          <input name="title" defaultValue={task.title} required className={INPUT} />
        </Field>
        <Field label="Category">
          <select name="category" defaultValue={task.category} className={INPUT}>
            {TASK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL(c)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Weight">
          <input
            type="number"
            name="weight"
            min={1}
            max={MAX_WEIGHT}
            defaultValue={task.weight}
            className={INPUT}
          />
        </Field>
        <Field label="Due">
          <input type="date" name="dueOn" defaultValue={zonedDateInput(task.dueOn, timezone)} className={INPUT} />
        </Field>
        <Field label="Owner">
          <select name="assigneeId" defaultValue={task.assigneeId ?? ''} className={INPUT}>
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="secondary" disabled={pending}>
            Save changes
          </Button>
          <Message state={state} />
        </div>
      </form>

      <form action={delAction} className="mt-2">
        <input type="hidden" name="showId" value={showId} />
        <input type="hidden" name="taskId" value={task.id} />
        <QuietSubmit
          pending={deleting}
          className="text-bad underline hover:no-underline"
        >
          Delete this task
        </QuietSubmit>
        <span className="ml-2 text-xs text-text-muted">
          Deleting removes it from the score entirely, and leaves no record that it existed.
          Skipping keeps the decision. Prefer skipping.
        </span>
        <Message state={del} />
      </form>
    </details>
  );
}

/* -------------------------------- templates -------------------------------- */

export function TemplateForm({
  showId,
  templates,
  hasTasks,
}: {
  showId: string;
  templates: ChecklistTemplate[];
  hasTasks: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(seedFromTemplate, {});

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="showId" value={showId} />
      {templates.map((t) => (
        <div key={t.key} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-medium">{t.name}</span>
          <Badge>{t.items.length} tasks</Badge>
          <Button
            type="submit"
            name="templateKey"
            value={t.key}
            variant="secondary"
            disabled={pending}
          >
            Apply
          </Button>
          <p className="w-full text-xs text-text-muted">{t.blurb}</p>
        </div>
      ))}
      {hasTasks && (
        <p className="text-xs text-text-muted">
          This show already has a checklist. Applying a template adds only what is missing —
          it never edits or re-dates a task you have already started.
        </p>
      )}
      <Message state={state} density="comfortable" />
    </form>
  );
}

/* --------------------------------- bits ------------------------------------ */

const INPUT =
  'mt-1 w-full rounded-md border border-border-strong bg-panel px-2 py-1.5 text-sm';

function Field({
  label,
  hint,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs font-medium text-text-muted">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-xs text-text-muted">{hint}</span>}
    </label>
  );
}

