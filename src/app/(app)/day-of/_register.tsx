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
    // Failure is fine and silent: no worker means no offline copy, which the
    // screen already says out loud when it has nothing cached.
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }, []);
  return null;
}
