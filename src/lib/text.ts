/**
 * Sentence helpers, for anything that composes prose a person reads.
 *
 * This lives under `src/lib` rather than beside the screens because the strings
 * that needed it most are **not** in `src/app`: an alert title, an audit-trail
 * note and a sweep summary are all written here and rendered there, so a helper
 * the view layer owned was unreachable from exactly the places carrying
 * `credit(s)` and `leg(s)`.
 *
 * `_components/text.ts` re-exports these, so there is one definition and the
 * screens keep their local import.
 */

/** `2 leads`, `1 lead` — the count and its noun, agreeing. */
export const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * A list joined the way a person says it out loud: "Ingrid, Reese and Tomás".
 *
 * The joining rule lives here once. `names` was the first caller and `setup/`
 * grew a second copy of the same three lines within a week of it — which is the
 * duplication this file exists to stop, arriving from inside.
 */
export function andList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The same, for people. */
export function names(list: { fullName: string }[]): string {
  return andList(list.map((p) => p.fullName));
}
