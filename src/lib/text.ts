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

/** Names joined the way a person says them out loud: "Ingrid, Reese and Tomás". */
export function names(list: { fullName: string }[]): string {
  const all = list.map((p) => p.fullName);
  if (all.length <= 1) return all.join('');
  return `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}
