import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type { z } from 'zod';
import {
  decodeStoredJson,
  readStorageItem,
  rememberStorageItem,
  type StorageArea,
  subscribeStorageItem,
} from '@/client/lib/browser-storage';

export interface PersistedStateOptions<T> {
  /**
   * `json` (default) stores `JSON.stringify(value)`. `text` stores
   * `String(value)` and validates the raw string, for keys that predate JSON.
   */
  format?: 'json' | 'text';
  /** Replaces the default encoding, e.g. to strip live fields before storing. */
  encode?: (value: T) => string;
  area?: StorageArea;
  /** Follow writes from other tabs of this origin. */
  crossTab?: boolean;
}

export type PersistedStateSetter<T> = (next: T | ((previous: T) => T)) => void;

const noSubscription = () => () => undefined;

function decode<T>(
  raw: string | null,
  schema: z.ZodType<T>,
  fallback: T,
  format: 'json' | 'text'
): T {
  if (raw === null) {
    return fallback;
  }
  if (format === 'json') {
    // A schema may accept a stored `null`; only a missing or invalid value falls back.
    const decoded = decodeStoredJson(raw, schema);
    return decoded === undefined ? fallback : decoded;
  }
  const result = schema.safeParse(raw);
  return result.success ? result.data : fallback;
}

/**
 * The stored string for `value`, or `undefined` when it cannot be encoded
 * (the encoder throws, or `JSON.stringify` yields no JSON, as for `undefined`).
 */
function encodeValue<T>(
  value: T,
  format: 'json' | 'text',
  encode: ((value: T) => string) | undefined
): string | undefined {
  try {
    const raw: unknown = encode
      ? encode(value)
      : format === 'json'
        ? JSON.stringify(value)
        : String(value);
    return typeof raw === 'string' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * State kept in Web Storage under `key`: read and validated on first render,
 * written by the setter, and shared by every mounted consumer of the key.
 * Values that are missing, unparsable or rejected by `schema` read as
 * `fallback`. When storage is unavailable or full the value still updates for
 * this page. A `null` key keeps the state in memory only.
 *
 * `schema`, `fallback` and `encode` are read when the stored value changes;
 * they need not be stable. The setter is stable for a given key.
 */
export function usePersistedState<T>(
  key: string | null,
  schema: z.ZodType<T>,
  fallback: T,
  { format = 'json', encode, area = 'local', crossTab = false }: PersistedStateOptions<T> = {}
): readonly [T, PersistedStateSetter<T>] {
  const [memoryValue, setMemoryValue] = useState(fallback);
  const codec = useRef({ schema, fallback, encode });
  codec.current = { schema, fallback, encode };
  // The decoded value for the last raw string, so snapshots stay referentially
  // stable and a consumer keeps the exact object it last stored.
  const cache = useRef<{ source: string; raw: string | null; value: T } | null>(null);
  const source = `${area}:${format}:${key}`;

  const getSnapshot = useCallback((): T => {
    if (key === null) {
      return codec.current.fallback;
    }
    const raw = readStorageItem(key, area);
    const cached = cache.current;
    if (cached && cached.source === source && cached.raw === raw) {
      return cached.value;
    }
    const value = decode(raw, codec.current.schema, codec.current.fallback, format);
    cache.current = { source, raw, value };
    return value;
  }, [key, area, format, source]);

  const subscribe = useCallback(
    (listener: () => void) => subscribeStorageItem(key ?? '', listener, { area, crossTab }),
    [key, area, crossTab]
  );

  const storedValue = useSyncExternalStore(
    key === null ? noSubscription : subscribe,
    getSnapshot,
    getSnapshot
  );

  const setValue = useCallback<PersistedStateSetter<T>>(
    (next) => {
      if (key === null) {
        setMemoryValue(next);
        return;
      }
      const previous = getSnapshot();
      const isUpdater = typeof next === 'function';
      const value = isUpdater ? (next as (previous: T) => T)(previous) : next;
      // An updater that returns its input changes nothing. An explicit value is
      // always stored, even when it equals the fallback or this page's copy.
      if (isUpdater && Object.is(value, previous)) {
        return;
      }
      const raw = encodeValue(value, format, codec.current.encode);
      // A value that cannot be encoded is neither stored nor shown.
      if (raw === undefined) {
        return;
      }
      cache.current = { source, raw, value };
      rememberStorageItem(key, raw, area);
    },
    [key, area, format, source, getSnapshot]
  );

  return [key === null ? memoryValue : storedValue, setValue] as const;
}
