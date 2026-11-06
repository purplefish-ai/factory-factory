import { useSyncExternalStore } from 'react';

type PendingWorkspace =
  | { status: 'creating'; name: string }
  | { status: 'created'; workspaceId: string }
  | { status: 'failed'; message: string };

// Keep request outcomes across route changes, so returning to an optimistic
// sidebar row never sends its temporary ID to the backend.
const workspaces = new Map<string, PendingWorkspace>();
const listeners = new Set<() => void>();

export function setPendingWorkspace(id: string, state: PendingWorkspace) {
  workspaces.set(id, state);
  listeners.forEach((listener) => listener());
}

export function usePendingWorkspace(id: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => workspaces.get(id)
  );
}
