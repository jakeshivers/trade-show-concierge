'use client';

import { useSyncExternalStore } from 'react';

/**
 * A per-browser preference — the collapsed sidebar, the theme choice.
 *
 * Read through `useSyncExternalStore` rather than "useState + read it in an
 * effect", which is the obvious shape and wrong twice: React 19 flags the
 * set-state-in-effect, and it renders one frame of the *default* before
 * correcting itself, so a person who collapsed the nav watches it open and shut
 * on every navigation.
 *
 * The server snapshot is the fallback, deliberately: the server has no
 * localStorage, so the first paint is the default and hydration agrees with it.
 * The no-flash exception is the theme, which the root layout's inline script
 * applies to <html> before paint — a wrong *width* for one frame is a nuisance,
 * a wrong *background* is a flash of white in a dark room.
 *
 * Nothing here belongs on the server. These are conveniences local to one
 * browser; anything that has to be true for a person on their other machine is
 * a database row, not this.
 */

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // `storage` fires in the *other* tabs, so two open tabs stay in step.
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function usePref(key: string, fallback: string): string {
  return useSyncExternalStore(
    subscribe,
    () => {
      try {
        return localStorage.getItem(key) ?? fallback;
      } catch {
        // Privacy modes throw on access rather than returning null.
        return fallback;
      }
    },
    () => fallback,
  );
}

/** `null` removes the key — absence is a state, not an absence of one. */
export function setPref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* the UI still updated; only the memory of it is lost */
  }
  listeners.forEach((l) => l());
}
