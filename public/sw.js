/*
 * The day-of service worker.
 *
 * It exists to answer one question: what does the browser do when somebody taps
 * the day-of screen in a hall with no signal? Without a worker the answer is the
 * browser's offline page, and every argument in `src/lib/dayof/` about stale
 * verdicts and queued captures is moot, because the app never runs.
 *
 * Written by hand rather than generated. A precache manifest built at compile
 * time would list Next's hashed chunks, which is the thing this deliberately
 * does *not* try to do: chunk names change every build, a stale precache
 * manifest serves a page that cannot hydrate, and debugging that on a show floor
 * is the worst possible place to discover it. So the strategy is boring and
 * self-healing: cache what has actually been fetched, prefer the network, and
 * fall back only when there is nothing else.
 *
 * Three rules, and the second is the one that matters.
 *
 * 1. **Only day-of navigations are cached.** Not /cost, not /travel, not
 *    /shows/*. Those pages are somebody's fares, a colleague's itinerary and a
 *    show's true cost, and a cache is a copy that outlives the session that was
 *    allowed to read it. Caching every page would be a lateral read waiting for
 *    a shared phone, which is the failure the whole access posture exists to
 *    close. The day-of page is cached because it has to be, and it is the page
 *    whose contents were already narrowed to this person.
 *
 * 2. **No API response is ever cached here.** The snapshot is cached by the
 *    client, into IndexedDB, with the instant it was taken — which is what makes
 *    `freshnessOf` able to say "as of 40 minutes ago" and what makes
 *    `degradeVerdicts` able to take the present tense away. A snapshot served
 *    back out of a HTTP cache arrives looking exactly like a fresh one, and the
 *    screen would say "on time" about a crate on the strength of a response the
 *    network never made. That is the unchecked-flight failure with a cache in
 *    front of it.
 *
 * 3. **Purge is a message, not a timer.** The client sends `purge` when the
 *    actor id in the snapshot stops matching the person signed in. A device that
 *    changes hands must not render the previous person's booth from cache.
 *
 * ## The one this got wrong (2026-09-02)
 *
 * Rule 4, learned the hard way: **`/_next/static/` is immutable in a production
 * build and is not immutable in `next dev`.** The comment on `isBuildAsset`
 * asserted content-hashing and was right about `next build`, where a chunk's
 * name contains a hash of its contents. Turbopack's dev chunks are named from
 * their *source path* — `_0sm9glu._.js`, `src_app_(app)__components_0d7r693._.js`
 * — and the same name is reused as the file behind it changes. Cache-first on
 * those pins one build's bytes into the browser forever.
 *
 * What that looks like is not a subtle staleness. The page loads a chunk from an
 * hour ago against a server render from now, a function that has since moved
 * throws `is not a function`, hydration fails, and the screen is dead — on the
 * one page in this product whose entire purpose is working when nothing else
 * does. It survives a dev-server restart, a rebuild and a normal reload, because
 * the stale copy is in the *browser's* cache and nothing on the server can reach
 * it. Debugging that on a show floor is precisely what this file's header says it
 * is trying to avoid, and the mechanism it warned about had been built in.
 *
 * So the worker is told which it is. In production nothing changes: hashed names
 * are served cache-first, which is the whole point of the offline copy. In
 * development build assets are network-first with a cache fallback, so the
 * offline path still works and no chunk is ever pinned.
 */

/**
 * Bumped from `day-of-v1` on 2026-09-02. `activate` deletes every cache that is
 * not this one, so a browser holding a poisoned copy heals itself on the next
 * load rather than needing somebody to know to clear site data.
 */
const CACHE = 'day-of-v2';

/**
 * Whether the build assets this worker sees are content-hashed.
 *
 * Passed at registration (`/sw.js?mode=dev`) rather than sniffed from the
 * hostname: a hostname is a guess about the environment and this is a fact the
 * app already knows. Anything other than an explicit `dev` is treated as
 * production, so the failure mode of a missing parameter is the correct
 * behaviour on a real deployment.
 */
const IMMUTABLE_ASSETS = new URL(self.location.href).searchParams.get('mode') !== 'dev';

self.addEventListener('install', (event) => {
  // Take over immediately. A worker waiting for every tab to close is a worker
  // that is not there on the morning somebody needs it.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'purge') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
  }
});

const isDayOf = (url) => url.pathname === '/day-of' || url.pathname.startsWith('/day-of/');

/** Content-hashed and immutable in a production build — and only there. */
const isBuildAsset = (url) => url.pathname.startsWith('/_next/static/');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Rule 2. Not cached, not intercepted — a failed snapshot fetch must reach the
  // client as a failure so it can fall back to IndexedDB and say how old that is.
  if (url.pathname.startsWith('/api/')) return;

  if (isBuildAsset(url)) {
    // Cache-first only where the name is a hash of the contents. In dev the same
    // name is reused across builds, so cache-first pins one build's bytes into
    // the browser permanently and the page stops hydrating.
    event.respondWith(IMMUTABLE_ASSETS ? cacheFirst(request) : networkFirst(request));
    return;
  }

  if (request.mode === 'navigate' && isDayOf(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Everything else: the network, or the browser's own failure. Rule 1.
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    // Only a real page. A redirect to /sign-in cached here would lock somebody
    // out of the offline screen with no way to see why.
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    // The picker fallback is for navigations only. A build asset that is missing
    // has to fail as a missing build asset — handing an HTML page back to a
    // <script> tag turns "offline" into a syntax error nobody can read.
    if (request.mode !== 'navigate') throw err;
    // No network and nothing cached for this URL: try the show picker, which is
    // the only other day-of page and may well be there.
    const fallback = await cache.match('/day-of');
    if (fallback) return fallback;
    throw err;
  }
}
