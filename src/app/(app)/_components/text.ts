/**
 * The screens' sentence helpers.
 *
 * Re-exported from `src/lib/text.ts` rather than defined here: the same
 * `credit(s)` / `leg(s)` problem exists in alert titles and audit notes, which
 * are composed in `src/lib` and cannot import from `src/app`. One definition,
 * two import paths, and this one stays dependency-free so a client component or
 * a server action can use it.
 */
export { names, plural } from '@/lib/text';
