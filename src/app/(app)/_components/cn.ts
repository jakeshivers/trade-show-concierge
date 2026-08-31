import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose class names, letting a caller's class win over a component's default.
 *
 * Both packages were already in `package.json` and used by nothing. Plain string
 * interpolation — which is what `ui.tsx`'s `Button` does — appends rather than
 * overrides, so passing `px-2` to something that defaults to `px-3` yields both
 * and the winner is whichever Tailwind emitted last. `twMerge` resolves that by
 * understanding the conflict groups.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
