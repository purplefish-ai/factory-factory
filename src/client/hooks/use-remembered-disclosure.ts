import { useCallback, useState, useSyncExternalStore } from 'react';

const MAX_UNMOUNTED_ENTRIES = 500;
const disclosures = new Map<string, boolean>();
const mountedKeys = new Map<string, number>();
const listeners = new Set<() => void>();

function pruneUnmountedEntries() {
  const unmountedKeys = [...disclosures.keys()].filter((key) => !mountedKeys.has(key));
  for (const key of unmountedKeys.slice(
    0,
    Math.max(0, unmountedKeys.length - MAX_UNMOUNTED_ENTRIES)
  )) {
    disclosures.delete(key);
  }
}

function subscribe(listener: () => void, key: string | undefined) {
  listeners.add(listener);
  if (key) {
    mountedKeys.set(key, (mountedKeys.get(key) ?? 0) + 1);
  }
  return () => {
    listeners.delete(listener);
    if (key) {
      const remaining = (mountedKeys.get(key) ?? 1) - 1;
      if (remaining > 0) {
        mountedKeys.set(key, remaining);
      } else {
        mountedKeys.delete(key);
        pruneUnmountedEntries();
      }
    }
  };
}

const serverSnapshot = () => undefined;

/** Remembers explicit disclosure choices for this page's lifetime, scoped to an entity. */
export function useRememberedDisclosure(
  scope: string | null | undefined,
  section: string,
  defaultOpen = false
): readonly [boolean, (open: boolean) => void] {
  const key = scope ? JSON.stringify([scope, section]) : undefined;
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const snapshot = useCallback(() => (key ? disclosures.get(key) : undefined), [key]);
  const subscribeToKey = useCallback((listener: () => void) => subscribe(listener, key), [key]);
  const rememberedOpen = useSyncExternalStore(subscribeToKey, snapshot, serverSnapshot);
  const setOpen = useCallback(
    (open: boolean) => {
      if (!key) {
        setLocalOpen(open);
        return;
      }
      // Bound retained navigation history without resetting any mounted disclosures.
      disclosures.delete(key);
      disclosures.set(key, open);
      pruneUnmountedEntries();
      for (const listener of listeners) {
        listener();
      }
    },
    [key]
  );
  return [key ? (rememberedOpen ?? defaultOpen) : localOpen, setOpen];
}
