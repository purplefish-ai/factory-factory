import { useSyncExternalStore } from 'react';

type PendingWorkspace =
  | { status: 'creating'; name: string }
  | { status: 'created'; workspaceId: string }
  | { status: 'failed'; message: string };

// Keep request outcomes across route changes, so returning to an optimistic
// sidebar row never sends its temporary ID to the backend.
const workspaces = new Map<string, PendingWorkspace>();
const completedLaunches = new Set<string>();
const MAX_COMPLETED_LAUNCHES = 100;
const listeners = new Set<() => void>();

export function setPendingWorkspace(id: string, state: PendingWorkspace) {
  workspaces.set(id, state);
  completedLaunches.delete(id);
  if (state.status !== 'creating') {
    completedLaunches.add(id);
  }
  if (completedLaunches.size > MAX_COMPLETED_LAUNCHES) {
    const oldest = completedLaunches.values().next().value;
    if (oldest !== undefined) {
      completedLaunches.delete(oldest);
      workspaces.delete(oldest);
    }
  }
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
