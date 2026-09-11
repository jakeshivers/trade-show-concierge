'use client';

import type { DaySnapshot } from '@/lib/dayof/snapshot';
import { SNAPSHOT_VERSION } from '@/lib/dayof/snapshot';
import type { QueuedItem } from '@/lib/dayof/outbox';

/**
 * The device's own storage — the only durable thing on the far side of a dead
 * connection.
 *
 * IndexedDB rather than `localStorage`, and not for the usual capacity reason.
 * `localStorage` is synchronous and, more to the point, it is *lossy under
 * pressure*: a browser reclaiming space on a phone at 4% battery drops it
 * without a word. What is stored here is a queue of conversations that exist
 * nowhere else, so it goes in the store the browser treats as data rather than
 * as a preference — and, where the API is available, in one it has been asked
 * not to evict.
 *
 * Everything here fails soft. A private window, a browser with site data
 * blocked, an origin whose quota is exhausted — all of them throw somewhere in
 * this file, and none of them is a reason for a booth staffer to see a blank
 * page. Every read answers `null` and every write reports whether it landed, so
 * `page.tsx` can say "this device is not storing anything — stay on wifi"
 * instead of silently pretending to queue.
 */

const DB_NAME = 'tsc-day-of';
const DB_VERSION = 1;
const SNAPSHOTS = 'snapshots';
const OUTBOX = 'outbox';

let handle: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (handle) return handle;
  handle = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS);
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: 'clientRef' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return handle;
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Whether this browser will actually keep anything. Asked once, said out loud. */
export async function storageAvailable(): Promise<boolean> {
  try {
    await open();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the browser not to evict this origin under storage pressure.
 *
 * Best-effort and unprompted-in-most-browsers; a refusal is not an error and
 * changes nothing about how the queue behaves. It is here because the thing
 * being stored is somebody's unsynced work, and not asking would be a choice.
 */
export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* nothing to do about it, and nothing worth telling anybody */
  }
}

/* -------------------------------- snapshots --------------------------------- */

export async function readSnapshot(showId: string): Promise<DaySnapshot | null> {
  try {
    const found = await run<DaySnapshot | undefined>(SNAPSHOTS, 'readonly', (s) => s.get(showId));
    if (!found) return null;
    // A snapshot written by an older build is discarded rather than rendered.
    // A missing field on a screen that a person is reading in a hurry is worse
    // than an empty one, because it looks like an answer.
    if (found.version !== SNAPSHOT_VERSION) return null;
    return found;
  } catch {
    return null;
  }
}

export async function writeSnapshot(snapshot: DaySnapshot): Promise<void> {
  try {
    await run(SNAPSHOTS, 'readwrite', (s) => s.put(snapshot, snapshot.show.id));
  } catch {
    /* the screen already knows storage is unavailable; see `storageAvailable` */
  }
}

/* ---------------------------------- outbox ---------------------------------- */

export async function readOutbox(): Promise<QueuedItem[]> {
  try {
    const all = await run<QueuedItem[]>(OUTBOX, 'readonly', (s) => s.getAll());
    return all.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
  } catch {
    return [];
  }
}

/**
 * Add one item, and report whether it is actually stored.
 *
 * The return value is load-bearing rather than defensive. If this comes back
 * false the capture is in a React state variable and nowhere else, and the
 * screen has to say so — "this device is not saving; do not close this tab" —
 * because the alternative is a person capturing forty leads into a browser that
 * will forget them the moment it is backgrounded.
 */
export async function enqueue(item: QueuedItem): Promise<boolean> {
  try {
    await run(OUTBOX, 'readwrite', (s) => s.put(item));
    return true;
  } catch {
    return false;
  }
}

/** Replace the queue with what `reconcile` says is left. Never a blind clear. */
export async function replaceOutbox(items: QueuedItem[]): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTBOX, 'readwrite');
      const store = tx.objectStore(OUTBOX);
      store.clear();
      for (const item of items) store.put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* the queue stays as it was, which is the safe direction */
  }
}

export async function removeQueued(clientRef: string): Promise<void> {
  try {
    await run(OUTBOX, 'readwrite', (s) => s.delete(clientRef));
  } catch {
    /* leave it queued */
  }
}

/**
 * Wipe everything this origin holds, including the service worker's caches.
 *
 * Called when the actor id on a snapshot stops matching the person signed in.
 * A phone in a booth gets handed to whoever is free, and a cached screen
 * outlives the session that was allowed to read it — so the moment the identity
 * changes, every copy goes, rather than the screen filtering what it renders.
 * Step 15's rule about a transcript belonging to the person in it, on a device.
 */
export async function purgeDevice(): Promise<void> {
  try {
    const db = await open();
    db.close();
    handle = null;
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  } catch {
    /* fall through to the caches, which matter just as much */
  }
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'purge' });
  } catch {
    /* nothing */
  }
}

/** A ref that does not need the network to be unique. */
export function randomRef(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
