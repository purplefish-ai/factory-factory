/**
 * The one module that touches Web Storage (lint: factory/no-direct-web-storage).
 *
 * Every access is guarded: reading the `localStorage` property itself throws
 * when storage is blocked, and writes throw when it is full. Reads then return
 * `null` and writes report failure instead of throwing.
 *
 * While a `usePersistedState` consumer is mounted, its key's raw value is
 * cached here, so every consumer of one key agrees, a write that storage
 * refuses still updates them for this page, and other tabs' writes apply only
 * to keys that opted into cross-tab sync.
 */
import type { z } from 'zod';

export type StorageArea = 'local' | 'session';

function storageFor(area: StorageArea): Storage | null {
  try {
    return (area === 'local' ? globalThis.localStorage : globalThis.sessionStorage) ?? null;
  } catch {
    return null;
  }
}

interface Entry {
  area: StorageArea;
  key: string;
  raw: string | null;
  crossTabSubscribers: number;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

function entryId(area: StorageArea, key: string): string {
  return `${area}:${key}`;
}

function readStorage(area: StorageArea, key: string): string | null {
  try {
    return storageFor(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(area: StorageArea, key: string, raw: string | null): boolean {
  try {
    const storage = storageFor(area);
    if (!storage) {
      return false;
    }
    if (raw === null) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, raw);
    }
    return true;
  } catch {
    return false;
  }
}

function publish(entry: Entry | undefined, raw: string | null, force = false) {
  if (!entry || (entry.raw === raw && !force)) {
    return;
  }
  entry.raw = raw;
  for (const listener of [...entry.listeners]) {
    listener();
  }
}

/** The stored string, or `null` when absent or storage is unavailable. */
export function readStorageItem(key: string, area: StorageArea = 'local'): string | null {
  const entry = entries.get(entryId(area, key));
  return entry ? entry.raw : readStorage(area, key);
}

/** Stores `value`, returning whether storage accepted it. */
export function writeStorageItem(key: string, value: string, area: StorageArea = 'local'): boolean {
  const written = writeStorage(area, key, value);
  if (written) {
    publish(entries.get(entryId(area, key)), value);
  }
  return written;
}

/** Removes `key`, returning whether storage accepted the removal. */
export function removeStorageItem(key: string, area: StorageArea = 'local'): boolean {
  const removed = writeStorage(area, key, null);
  if (removed) {
    publish(entries.get(entryId(area, key)), null);
  }
  return removed;
}

/**
 * Stores a mounted consumer's value and notifies every consumer, even when the
 * stored string is unchanged. When storage refuses it, mounted consumers still
 * see the value until they all unmount.
 */
export function rememberStorageItem(key: string, value: string, area: StorageArea = 'local') {
  writeStorage(area, key, value);
  publish(entries.get(entryId(area, key)), value, true);
}

/** Local storage for modules that take an injectable `Storage`-like dependency. */
export const localStore = {
  getItem: (key: string): string | null => readStorageItem(key),
  setItem: (key: string, value: string): void => {
    writeStorageItem(key, value);
  },
  removeItem: (key: string): void => {
    removeStorageItem(key);
  },
};

/** Parses a stored JSON value with `schema`; `undefined` when absent or invalid. */
export function readStoredJson<T>(
  key: string,
  schema: z.ZodType<T>,
  area: StorageArea = 'local'
): T | undefined {
  return decodeStoredJson(readStorageItem(key, area), schema);
}

export function decodeStoredJson<T>(raw: string | null, schema: z.ZodType<T>): T | undefined {
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Stores `value` as JSON, returning whether storage accepted it. */
export function writeStoredJson(key: string, value: unknown, area: StorageArea = 'local'): boolean {
  return writeStorageItem(key, JSON.stringify(value), area);
}

function matchesStorageArea(event: StorageEvent, area: StorageArea): boolean {
  return event.storageArea === null || event.storageArea === storageFor(area);
}

function onStorage(event: StorageEvent) {
  for (const entry of entries.values()) {
    // A null key means another tab cleared storage.
    if (
      entry.crossTabSubscribers > 0 &&
      matchesStorageArea(event, entry.area) &&
      (event.key === null || event.key === entry.key)
    ) {
      publish(entry, readStorage(entry.area, entry.key));
    }
  }
}

let crossTabSubscribers = 0;

/**
 * Subscribes to one key's changes from this module, and, with `crossTab`, to
 * writes from other tabs of this origin.
 */
export function subscribeStorageItem(
  key: string,
  listener: () => void,
  { area = 'local', crossTab = false }: { area?: StorageArea; crossTab?: boolean } = {}
): () => void {
  const id = entryId(area, key);
  let entry = entries.get(id);
  if (!entry) {
    entry = {
      area,
      key,
      raw: readStorage(area, key),
      crossTabSubscribers: 0,
      listeners: new Set(),
    };
    entries.set(id, entry);
  }
  const subscribed = entry;
  subscribed.listeners.add(listener);
  if (crossTab) {
    subscribed.crossTabSubscribers += 1;
    crossTabSubscribers += 1;
    if (crossTabSubscribers === 1) {
      window.addEventListener('storage', onStorage);
    }
  }
  return () => {
    subscribed.listeners.delete(listener);
    if (crossTab) {
      subscribed.crossTabSubscribers -= 1;
      crossTabSubscribers -= 1;
      if (crossTabSubscribers === 0) {
        window.removeEventListener('storage', onStorage);
      }
    }
    if (subscribed.listeners.size === 0 && entries.get(id) === subscribed) {
      entries.delete(id);
    }
  };
}
