import { z } from 'zod';
import { sessionLaunchSelectionSnapshotSchema } from '@/client/features/session-selection';
import { AttachmentSchema } from '@/shared/websocket';

export const workspaceCreationDraftSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().min(1),
  prompt: z.string(),
  attachments: z.array(AttachmentSchema),
  ratchetEnabled: z.boolean(),
  ratchetInitialized: z.boolean().default(true),
  launchSelection: sessionLaunchSelectionSnapshotSchema.optional(),
  mode: z.enum(['STANDARD', 'PERIODIC_TASK']),
  cadence: z.enum(['EVERY_MINUTE', 'EVERY_FIVE_MINUTES', 'DAILY', 'WEEKLY', 'MONTHLY']),
  scheduledTime: z.string(),
});
export type WorkspaceCreationDraft = z.infer<typeof workspaceCreationDraftSchema>;
export function createWorkspaceCreationDraft(): WorkspaceCreationDraft {
  return {
    schemaVersion: 1,
    revision: crypto.randomUUID(),
    prompt: '',
    attachments: [],
    ratchetEnabled: false,
    ratchetInitialized: false,
    mode: 'STANDARD',
    cadence: 'DAILY',
    scheduledTime: '',
  };
}

export const WORKSPACE_DRAFT_DATABASE_NAME = 'factory-factory-workspace-drafts';
export const WORKSPACE_DRAFT_DATABASE_VERSION = 1;
export const WORKSPACE_DRAFT_STORE_NAME = 'drafts';

export interface WorkspaceDraftSnapshot {
  hasUnreadableDraft: boolean;
  draft: WorkspaceCreationDraft | null;
  isRestoring: boolean;
  generation: number;
  persistenceError: string | null;
}
interface Entry {
  snapshot: WorkspaceDraftSnapshot;
  listeners: Set<() => void>;
  loading?: Promise<WorkspaceCreationDraft | null>;
  queue: Promise<unknown>;
  cleared: Set<string>;
  parents: Map<string, string>;
}
const entries = new Map<string, Entry>();
function entryFor(projectId: string): Entry {
  let entry = entries.get(projectId);
  if (!entry) {
    entry = {
      snapshot: {
        hasUnreadableDraft: false,
        draft: null,
        isRestoring: true,
        persistenceError: null,
        generation: 0,
      },
      listeners: new Set(),
      queue: Promise.resolve(),
      cleared: new Set(),
      parents: new Map(),
    };
    entries.set(projectId, entry);
  }
  return entry;
}
function publish(entry: Entry, patch: Partial<WorkspaceDraftSnapshot>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  entry.listeners.forEach((listener) => listener());
}
export function getWorkspaceCreationDraftSnapshot(projectId: string) {
  return entryFor(projectId).snapshot;
}
export function subscribeWorkspaceCreationDraft(projectId: string, listener: () => void) {
  const entry = entryFor(projectId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

let opening: Promise<IDBDatabase> | undefined;
function openDatabase() {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    let finished = false;
    const fail = () => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(new Error('Draft storage is unavailable'));
      }
    };
    const timer = setTimeout(fail, 1500);
    try {
      const request = indexedDB.open(
        WORKSPACE_DRAFT_DATABASE_NAME,
        WORKSPACE_DRAFT_DATABASE_VERSION
      );
      request.onupgradeneeded = () => request.result.createObjectStore(WORKSPACE_DRAFT_STORE_NAME);
      request.onerror = fail;
      request.onblocked = fail;
      request.onsuccess = () => {
        if (finished) {
          request.result.close();
          return;
        }
        finished = true;
        clearTimeout(timer);
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          opening = undefined;
        };
        resolve(database);
      };
    } catch {
      fail();
    }
  }).catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}
async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, result: (value: T) => void) => void
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(WORKSPACE_DRAFT_STORE_NAME, mode);
    let result: T;
    const timer = setTimeout(() => {
      transaction.abort();
      reject(new Error('Draft storage timed out'));
    }, 1500);
    transaction.oncomplete = () => {
      clearTimeout(timer);
      resolve(result);
    };
    transaction.onabort = transaction.onerror = () => {
      clearTimeout(timer);
      reject(transaction.error ?? new Error('Draft storage failed'));
    };
    try {
      action(transaction.objectStore(WORKSPACE_DRAFT_STORE_NAME), (value) => {
        result = value;
      });
    } catch (error) {
      clearTimeout(timer);
      transaction.abort();
      reject(error);
    }
  });
}
function enqueue<T>(entry: Entry, action: () => Promise<T>): Promise<T> {
  const pending = entry.queue.then(action);
  entry.queue = pending.catch(() => undefined);
  return pending;
}
export function loadWorkspaceCreationDraft(
  projectId: string
): Promise<WorkspaceCreationDraft | null> {
  const entry = entryFor(projectId);
  if (!entry.snapshot.isRestoring) {
    return Promise.resolve(entry.snapshot.draft);
  }
  entry.loading ??= enqueue(entry, async () => {
    try {
      const raw = await transact<unknown>('readonly', (store, result) => {
        const request = store.get(projectId);
        request.onsuccess = () => result(request.result);
      });
      const parsed = workspaceCreationDraftSchema.safeParse(raw);
      if (raw !== undefined && !parsed.success) {
        publish(entry, { hasUnreadableDraft: true });
        throw new Error('Invalid saved draft');
      }
      const draft = parsed.success ? parsed.data : null;
      if (entry.snapshot.isRestoring) {
        publish(entry, { draft, isRestoring: false });
      }
      return entry.snapshot.draft;
    } catch (cause) {
      const message =
        'Your draft and attachments could not be restored. Changes may not survive a refresh.';
      publish(entry, { isRestoring: false, persistenceError: message });
      throw new Error(message, { cause });
    }
  });
  return entry.loading;
}
export function saveWorkspaceCreationDraft(
  projectId: string,
  draft: WorkspaceCreationDraft
): Promise<void> {
  const entry = entryFor(projectId);
  if (entry.cleared.has(draft.revision)) {
    return Promise.resolve();
  }
  const previous = entry.snapshot.draft;
  if (previous && previous.revision !== draft.revision) {
    entry.parents.set(draft.revision, previous.revision);
  }
  // Publish before any await: navigating away immediately must retain this edit.
  publish(entry, { draft, isRestoring: false, hasUnreadableDraft: false });
  return enqueue(entry, async () => {
    try {
      await transact<void>('readwrite', (store) => {
        store.put(draft, projectId);
      });
      publish(entry, { persistenceError: null });
    } catch (cause) {
      const message =
        'Your draft could not be saved. Keep this tab open to retain instructions and attachments.';
      publish(entry, { persistenceError: message });
      throw new Error(message, { cause });
    }
  });
}
function isOwnedAncestor(entry: Entry, revision: string, expectedRevision: string): boolean {
  const visited = new Set<string>();
  let current: string | undefined = expectedRevision;
  while (current !== undefined && !visited.has(current)) {
    if (current === revision) {
      return true;
    }
    visited.add(current);
    current = entry.parents.get(current);
  }
  return false;
}
export function clearWorkspaceCreationDraft(
  projectId: string,
  expectedRevision: string
): Promise<boolean> {
  const entry = entryFor(projectId);
  entry.cleared.add(expectedRevision);
  const matches = entry.snapshot.draft?.revision === expectedRevision;
  if (matches) {
    publish(entry, { draft: null, isRestoring: false, generation: entry.snapshot.generation + 1 });
  }
  return enqueue(entry, async () => {
    try {
      const cleared = await transact<boolean>('readwrite', (store, result) => {
        const request = store.get(projectId);
        request.onsuccess = () => {
          const parsed = workspaceCreationDraftSchema.safeParse(request.result);
          const matching =
            parsed.success && isOwnedAncestor(entry, parsed.data.revision, expectedRevision);
          if (matching) {
            store.delete(projectId);
          }
          result(matching);
        };
      });
      if (entry.snapshot.draft === null) {
        publish(entry, { persistenceError: null });
      }
      return cleared || matches;
    } catch (cause) {
      const message = 'Your saved draft could not be cleared. It may return after a refresh.';
      publish(entry, { persistenceError: message });
      throw new Error(message, { cause });
    }
  });
}

/** Explicit discard also allows removing a record that failed schema validation. */
export function discardWorkspaceCreationDraft(projectId: string): Promise<boolean> {
  const entry = entryFor(projectId);
  if (!entry.snapshot.hasUnreadableDraft) {
    const revision = entry.snapshot.draft?.revision;
    return revision ? clearWorkspaceCreationDraft(projectId, revision) : Promise.resolve(false);
  }
  const captured = entry.snapshot;
  return enqueue(entry, async () => {
    try {
      const outcome = await transact<{ discarded: boolean; draft: WorkspaceCreationDraft | null }>(
        'readwrite',
        (store, result) => {
          const request = store.get(projectId);
          request.onsuccess = () => {
            const parsed = workspaceCreationDraftSchema.safeParse(request.result);
            const invalid = request.result !== undefined && !parsed.success;
            if (invalid) {
              store.delete(projectId);
            }
            result({ discarded: invalid, draft: parsed.success ? parsed.data : null });
          };
        }
      );
      if (
        entry.snapshot.generation === captured.generation &&
        entry.snapshot.draft === captured.draft
      ) {
        publish(entry, {
          draft: outcome.draft,
          hasUnreadableDraft: false,
          persistenceError: null,
          generation: captured.generation + 1,
        });
      }
      return outcome.discarded;
    } catch (cause) {
      const message = 'Your saved draft could not be cleared. It may return after a refresh.';
      publish(entry, { persistenceError: message });
      throw new Error(message, { cause });
    }
  });
}
