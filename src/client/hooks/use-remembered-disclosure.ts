import { useCallback, useState, useSyncExternalStore } from 'react';

const MAX_ENTRIES = 500;
const disclosures = new Map<string, boolean>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
  const rememberedOpen = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const setOpen = useCallback(
    (open: boolean) => {
      if (!key) {
        setLocalOpen(open);
        return;
      }
      // Keep recently changed entries at the end and bound memory across long sessions.
      disclosures.delete(key);
      disclosures.set(key, open);
      if (disclosures.size > MAX_ENTRIES) {
        const oldest = disclosures.keys().next().value;
        if (oldest !== undefined) {
          disclosures.delete(oldest);
        }
      }
      for (const listener of listeners) {
        listener();
      }
    },
    [key]
  );
  return [key ? (rememberedOpen ?? defaultOpen) : localOpen, setOpen];
}
