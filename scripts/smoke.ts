/**
 * Fetch every route and confirm it rendered.
 *
 *   pnpm dev &                # the server this checks
 *   pnpm smoke                # all routes, one line each
 *   pnpm smoke http://…:3001  # somewhere else
 *
 * This exists because of a gap named in UI-REWORK.md §9: all 436 tests are pure
 * — no DOM, no rendering, no database — and **none of them touch `src/app`**.
 * The only coupling between `src/lib` and `src/app` is types, so `pnpm
 * typecheck` catches a broken import and nothing at all catches a page that
 * throws at render. Every UI tranche is therefore verified by hand, and a check
 * done by hand every time is a check that eventually is not done.
 *
 * It is deliberately shallow: status 200 plus one phrase that only appears when
 * the page actually resolved its data. That is enough to catch the failure this
 * work can realistically cause — a bad import, a null deref in a component, a
 * server action module imported from a client boundary — and it does not
 * pretend to be a test of behaviour, which lives in `src/lib` where it is pure.
 *
 * The show-scoped routes need a real id, so it reads one from the database
 * rather than hard-coding a seed uuid that `pnpm db:reset` invalidates.
 *
 * **If this reports 404s on every show route, restart `pnpm dev`.** PGlite is a
 * directory, `pnpm db:reset` deletes it, and a dev server started beforehand is
 * still holding the old one — so the app 404s on ids that are certainly there.
 * The failure looks exactly like a broken page and is not one.
 */
import { asc } from 'drizzle-orm';
import { getDb } from '../src/db';
import * as s from '../src/db/schema';

const base = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');

type Check = { path: string; expect: string };

async function routes(): Promise<Check[]> {
  const db = getDb();
  const shows = await db.select().from(s.shows).orderBy(asc(s.shows.startsOn));
  const show = shows.find((x) => x.status !== 'cancelled') ?? shows[0];
  if (!show) throw new Error('No shows in the database. Run `pnpm db:reset` first.');

  const id = show.id;

  const checks: Check[] = [
    { path: '/', expect: 'Overview' },
    { path: '/shows', expect: show.name },
    { path: '/shows/new', expect: 'Propose' },
    { path: `/shows/${id}`, expect: show.name },
    { path: `/shows/${id}/readiness`, expect: 'deadline' },
    { path: `/shows/${id}/team`, expect: 'shift' },
    { path: `/shows/${id}/lodging`, expect: 'otel' },
    { path: `/shows/${id}/travel`, expect: 'ravel' },
    { path: `/shows/${id}/logistics`, expect: 'Shipments' },
    // Case matters, and this one moved: the lower-case phrase came from a
    // sentence that only renders when a show *has* an unknown-basis lead, so it
    // silently depended on which show sorted first. The column heading is there
    // whenever the tab resolved its data, which is what this check is for.
    { path: `/shows/${id}/leads`, expect: 'Target accounts' },
    { path: `/shows/${id}/clone`, expect: 'lone' },
    // Approver-only, like /cost. As a Member both of these render the refusal
    // instead of the figures, which is the access model working rather than a
    // smoke failure — same caveat as /settings/security below.
    { path: `/shows/${id}/cost`, expect: 'has cost so far' },
    { path: `/shows/${id}/roi`, expect: 'Was it worth it' },
    // Stale for a commit: the sentence this looked for was page copy explaining
    // *why* the feature has the ceiling it has, and the safety copy pass deleted
    // it. Both cards here title themselves differently once a roll call is open,
    // so this takes the resting-state heading — the show smoke picks is the
    // earliest one, which is not the one the seed runs a roll call on.
    { path: `/shows/${id}/safety`, expect: 'Who is expected here' },
    { path: '/safety', expect: 'Duty of care' },
    { path: '/readiness', expect: 'eadiness' },
    { path: '/alerts', expect: 'engines' },
    // A column heading rather than a sentence: the blurb this used to look for
    // was rewritten by a copy pass, and a heading is there whenever the table
    // resolved, which is what this check is actually for.
    { path: '/cost', expect: 'Nothing recorded for' },
    { path: '/roi', expect: 'attribution window' },
    { path: '/itinerary', expect: 'tinerary' },
    { path: '/travel', expect: 'ravel' },
    { path: '/travel/new', expect: 'equest' },
    { path: '/travel/approvals', expect: 'pproval' },
    { path: '/flights', expect: 'ove-in' },
    { path: '/shipping', expect: 'dock opens' },
    // A stat label rather than a blurb sentence, for the reason /cost's check
    // moved — and deliberately not the conflicts card, which only renders when
    // two shows actually clash. This one is in the summary grid unconditionally.
    { path: '/assets', expect: 'Outside the building' },
    { path: '/leads', expect: 'how complete it is' },
    { path: '/day-of', expect: 'while you still have a connection' },
    // The only page here whose content is *not* server-rendered, so the phrase
    // has to be one the shell prints before the client has read IndexedDB or
    // reached the snapshot route — which is the whole design, not a limitation.
    { path: `/day-of/${id}`, expect: 'device' },
    { path: '/assistant', expect: 'never books' },
    // Admin-only: with DEV_ACTOR_EMAIL set to a member this legitimately 404s,
    // which is the shell working rather than a smoke failure.
    { path: '/settings/security', expect: 'Sign-in methods' },
    { path: '/settings/intake', expect: 'intake' },
    // Not admin-only, unlike everything else under Settings: where your own
    // alerts go is yours to set.
    { path: '/settings/profile', expect: 'Traveler details' },
    { path: '/settings/notifications', expect: 'Where your alerts go' },
    // Approver-only, like /cost and /roi: a sync reads a customer's pipeline
    // and writes back into it.
    { path: '/settings/crm', expect: 'Attribution' },
  ];
  const request = await firstTravelRequest();
  if (request) checks.push({ path: `/travel/${request}`, expect: 'equest' });

  // Same reasoning as the travel request above, for a stricter reason: an
  // assistant conversation belongs to one person and nobody else can open it,
  // so the only id that is legitimately a 200 is one scraped from the list page
  // as whoever DEV_ACTOR_EMAIL names.
  const conversation = await firstConversation();
  if (conversation) checks.push({ path: `/assistant/${conversation}`, expect: 'onversation' });
  return checks;
}

/**
 * A request id taken from what /travel actually links to, rather than the first
 * row in the table.
 *
 * Those are not the same set and picking the wrong one made this script flaky:
 * `travelerScope` narrows the queue to the acting user unless they can approve,
 * so an arbitrary row is a legitimate 404 for whoever DEV_ACTOR_EMAIL names.
 * A smoke check that fails on correct authorization is a check people learn to
 * ignore.
 */
async function firstTravelRequest(): Promise<string | null> {
  // Approvals first: /travel is "requests you opened or are flying on", and an
  // admin who books nobody's travel but their own legitimately has none.
  for (const from of ['/travel/approvals', '/travel']) {
    const res = await fetch(`${base}${from}`);
    const m = /\/travel\/([0-9a-f-]{36})/.exec(await res.text());
    if (m) return m[1];
  }
  return null;
}

async function firstConversation(): Promise<string | null> {
  const res = await fetch(`${base}/assistant`);
  const m = /\/assistant\/([0-9a-f-]{36})/.exec(await res.text());
  return m ? m[1] : null;
}

/** Tags out, entities in, whitespace collapsed — enough to grep prose. */
function text(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ');
}

async function main() {
  const checks = await routes();
  let failed = 0;

  for (const check of checks) {
    const url = `${base}${check.path}`;
    let line: string;
    try {
      const res = await fetch(url, { redirect: 'manual' });
      const body = text(await res.text());
      const found = body.includes(check.expect);
      if (res.status !== 200) {
        failed++;
        line = `FAIL ${res.status}  ${check.path}`;
      } else if (!found) {
        failed++;
        line = `FAIL text  ${check.path}  (no "${check.expect}")`;
      } else {
        line = `ok   200   ${check.path}`;
      }
    } catch (err) {
      failed++;
      line = `FAIL net   ${check.path}  ${(err as Error).message}`;
    }
    console.log(line);
  }

  console.log(
    failed === 0
      ? `\n${checks.length} routes, all 200.`
      : `\n${failed} of ${checks.length} routes failed.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
