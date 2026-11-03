import type { MessageAttachment } from '@/lib/chat-protocol';

// Images dropped to start a new workspace wait here until the lazily loaded
// draft code appends them to the project's persisted creation draft. This module
// must stay dependency-free: it is part of the always-mounted sidebar, while the
// draft storage and creation form load only after the first drop or "+" click.

interface Entry {
  generation: number;
  attachments: MessageAttachment[];
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let pendingProjectIds: readonly string[] = [];

function entryFor(projectId: string): Entry {
  let entry = entries.get(projectId);
  if (!entry) {
    entry = { generation: 0, attachments: [] };
    entries.set(projectId, entry);
  }
  return entry;
}

function publish() {
  pendingProjectIds = [...entries]
    .filter(([, entry]) => entry.attachments.length > 0)
    .map(([projectId]) => projectId);
  listeners.forEach((listener) => listener());
}

export function subscribeWorkspaceCreationDrops(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes whenever the project's draft is cleared or discarded. */
export function getWorkspaceCreationDropGeneration(projectId: string) {
  return entries.get(projectId)?.generation ?? 0;
}

/** Stable between changes, for `useSyncExternalStore`. */
export function getPendingWorkspaceCreationDropProjectIds() {
  return pendingProjectIds;
}

/** Queue attachments read under `generation`; reads from a cleared draft are dropped. */
export function stageWorkspaceCreationAttachments(
  projectId: string,
  generation: number,
  attachments: MessageAttachment[]
) {
  const entry = entryFor(projectId);
  if (entry.generation !== generation || attachments.length === 0) {
    return;
  }
  entry.attachments = [...entry.attachments, ...attachments];
  publish();
}

export function takeWorkspaceCreationAttachments(projectId: string): MessageAttachment[] {
  const entry = entries.get(projectId);
  if (!entry || entry.attachments.length === 0) {
    return [];
  }
  const { attachments } = entry;
  entry.attachments = [];
  publish();
  return attachments;
}

/** Drop queued and in-flight attachments when the project's draft generation changes. */
export function resetWorkspaceCreationDrops(projectId: string) {
  const entry = entryFor(projectId);
  entry.generation += 1;
  entry.attachments = [];
  publish();
}
