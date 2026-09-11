'use client';

import { useEffect } from 'react';

/**
 * Register the day-of service worker.
 *
 * Mounted on the day-of pages only, not in the app shell. Registering a worker
 * on every page would put one in front of every request in the product for
 * people who will never open this screen, and `sw.js` deliberately declines to
 * cache any of those pages anyway — a worker that intercepts everything and
 * caches almost nothing is a moving part with no job.
 *
 * The consequence is worth stating on the screen rather than hiding: **the
 * offline screen only works if you opened it while you had a connection.** There
 * is no way around that — a browser cannot cache a page it has never seen — and
 * pretending otherwise is how somebody arrives at a hall on move-in morning
 * having installed nothing.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // The worker is *told* whether build assets are content-hashed rather than
    // sniffing a hostname, because this is a fact the app already holds. It
    // matters: `/_next/static/` is immutable in a production build and is not in
    // `next dev`, where Turbopack names chunks from their source path and reuses
    // the name as the file changes. Cache-first on those pins one build's bytes
    // into the browser permanently, and the day-of page then loads an hour-old
    // chunk against a current render and dies on hydration — surviving a dev
    // restart, because the stale copy is in the browser rather than on the
    // server. `public/sw.js` has the long version.
    //
    // Changing the script URL also replaces any worker registered at the old
    // one, which is what lets a browser already holding a poisoned cache heal
    // itself: the new worker's `activate` deletes every cache but its own.
    const url = process.env.NODE_ENV === 'production' ? '/sw.js' : '/sw.js?mode=dev';
    // Failure is fine and silent: no worker means no offline copy, which the
    // screen already says out loud when it has nothing cached.
    navigator.serviceWorker.register(url, { scope: '/' }).catch(() => {});
  }, []);
  return null;
}
