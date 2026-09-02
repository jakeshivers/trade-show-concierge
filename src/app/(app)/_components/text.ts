/**
 * Sentence helpers shared by the screens.
 *
 * Dependency-free, for `_components/form.ts`'s reason turned around: that file
 * stays clean of `next/cache` so a *client* component can import it, and this
 * one stays clean of React so a **server action** can. Both `page.tsx` and
 * `actions.ts` write sentences with counts in them, and a helper that lived in a
 * `.tsx` beside a `<Badge>` would drag components into an action module.
 *
 * `plural` exists because of the tell `UI-REWORK.md` §14 named: `lead(s)` and
 * `row(s)` are what template text looks like when nobody has read it back as a
 * sentence, and there were eight of them left after that pass.
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
