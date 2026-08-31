import { zonedDateInput, zonedTimeInput } from '@/lib/datetime/zoned';
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

const CONTROL_BASE =
  'rounded-lg border border-border-strong bg-panel text-text transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const CONTROL: Record<Density, string> = {
  compact: `${CONTROL_BASE} px-2 py-1 text-xs`,
  comfortable: `${CONTROL_BASE} w-full p-2 text-sm`,
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
      <span className="text-sm font-medium text-text">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-text-muted">{hint}</span>}
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
        state.error ? 'text-bad' : 'text-good',
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
        'text-xs text-text-muted hover:underline disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    >
      {pending && busy ? busy : children}
    </button>
  );
}

/**
 * A date and a time input for one instant, read in one zone, labelled with that
 * zone.
 *
 * The formatting is `zonedDateInput` / `zonedTimeInput` from
 * `lib/datetime/zoned.ts` — where it is tested — and this component exists so
 * the view layer stops rewriting it. Four hand-rolled copies preceded it, none
 * covered by a test, in a codebase whose whole position on dates is that
 * `new Date()` and `toISOString()` are how a flight time or a deadline silently
 * moves. `src/lib/datetime` was never the layer with that bug; `src/app` was.
 *
 * The zone label is not decoration either. These fields are read in the *show's*
 * zone, not the reader's, so an unlabelled pair of boxes on a Chicago show asks
 * a person in Berlin a question with two plausible answers.
 */
export function ZonedDateTime({
  label,
  dateName,
  timeName,
  instant,
  timeZone,
  required,
  defaultTime,
}: {
  label?: string;
  dateName: string;
  timeName: string;
  /** The current value, or null for a blank (new) row. */
  instant?: Date | null;
  timeZone: string;
  required?: boolean;
  /** Used only when there is no instant — e.g. a hotel's default check-in. */
  defaultTime?: string;
}) {
  const date = zonedDateInput(instant, timeZone);
  const time = zonedTimeInput(instant, timeZone);
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs text-text-muted">
      {label}
      <Input type="date" name={dateName} required={required} defaultValue={date} />
      <Input type="time" name={timeName} required={required} defaultValue={time || defaultTime} />
      <abbr title={timeZone} className="no-underline">
        {zoneAbbreviation(timeZone, instant)}
      </abbr>
    </span>
  );
}

/**
 * "CST", "JST" — the short name for the zone, not the reader's.
 *
 * Read *at the instant being edited*, not at now: a shift in July is CDT and one
 * in January is CST, and a label that says CST beside a July date is a small lie
 * of exactly the kind this app spends its datetime module avoiding. A blank row
 * has no instant to read, so it falls back to today.
 */
function zoneAbbreviation(timeZone: string, at?: Date | null): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(at ?? new Date())
      .find((p) => p.type === 'timeZoneName');
    return parts?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}
