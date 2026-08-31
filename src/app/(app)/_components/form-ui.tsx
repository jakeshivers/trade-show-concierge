import { cn } from './cn';
import type { FormState } from './form';

/**
 * The four things every form on every screen hand-wrote around `useActionState`:
 * an input, a labelled wrapper, the error/ok line, and the submit button's
 * pending state.
 *
 * `useActionState` itself stays at the call site. It is React's API, it returns
 * three values the caller needs, and wrapping it would mean inventing a worse
 * one — so what is shared here is only the markup around it. That is where the
 * duplication actually was: six verbatim copies of one `input` class string and
 * eleven hand-rendered error spans, which meant "make errors more visible" was
 * an eleven-file diff.
 *
 * **Two densities, on purpose.** `compact` is for the controls that live inside
 * a list row — the roster, the deadline register, the room block — where a form
 * has to sit in a table without pushing it around. `comfortable` is for a page
 * that *is* a form: intake, a travel request, the clone screen. They are named
 * rather than left to each caller's judgement because the drift between "text-xs
 * in a row" and "text-sm on a page" is exactly what six copies of a class string
 * turns into.
 */

export type Density = 'compact' | 'comfortable';

const CONTROL: Record<Density, string> = {
  compact:
    'rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-950',
  comfortable:
    'w-full rounded-md border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-700 dark:bg-zinc-950',
};

/** The one input class string, as a class string, for the cases that need one. */
export function controlClass(density: Density = 'compact', extra?: string): string {
  return cn(CONTROL[density], extra);
}

type Own = { density?: Density };

export function Input({
  density = 'compact',
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & Own) {
  return <input {...props} className={controlClass(density, className)} />;
}

export function Select({
  density = 'compact',
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & Own) {
  return <select {...props} className={controlClass(density, className)} />;
}

export function Textarea({
  density = 'comfortable',
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & Own) {
  return <textarea {...props} className={controlClass(density, className)} />;
}

/**
 * A labelled control on a page-sized form.
 *
 * The hint is not decoration. Several of them carry the only warning a person
 * gets about something this codebase treats as a correctness rule — "deadlines
 * are read in the show's local time, not yours" — so the wrapper renders it in
 * a fixed place rather than leaving each form to remember.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  );
}

/**
 * What the action said. Both halves, in one place, so a screen cannot render the
 * failure and quietly drop the success — which is precisely what happened while
 * `FormState` had drifted into `{ error, saved }` on one screen and
 * `{ error, ok }` on the others.
 */
export function Message({
  state,
  density = 'compact',
  className,
}: {
  state: FormState;
  density?: Density;
  className?: string;
}) {
  if (!state.error && !state.ok) return null;
  const size = density === 'compact' ? 'text-xs' : 'text-sm';
  return (
    <p
      role="status"
      className={cn(
        size,
        state.error ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400',
        className,
      )}
    >
      {state.error ?? state.ok}
    </p>
  );
}

/**
 * The submit button an inline row form uses — shaped like the inputs beside it,
 * because in a table it sits on the same line as them.
 *
 * `pending` is a separate prop from `disabled` so a caller can express both:
 * "this control is not available to you" and "this control is mid-flight" are
 * different sentences, and several screens need to say the first (see
 * `availableActions` in `lib/travel/review.ts`, which attaches a reason to every
 * refusal).
 */
export function Submit({
  pending,
  busy,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean; busy?: string }) {
  return (
    <button
      type="submit"
      {...props}
      disabled={pending || props.disabled}
      className={controlClass(
        'compact',
        cn('font-medium disabled:cursor-not-allowed disabled:opacity-50', className),
      )}
    >
      {pending && busy ? busy : children}
    </button>
  );
}

/**
 * The quiet one — un-staff, drop, remove. Deliberately not a red button: these
 * actions are frequent, reversible in the app, and *not* reversible outside it
 * (the ticket is still with the airline), so the weight belongs in the sentence
 * the store makes you acknowledge, not in the styling.
 */
export function QuietSubmit({
  pending,
  busy,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean; busy?: string }) {
  return (
    <button
      type="submit"
      {...props}
      disabled={pending || props.disabled}
      className={cn(
        'text-xs text-zinc-500 hover:underline disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {pending && busy ? busy : children}
    </button>
  );
}
