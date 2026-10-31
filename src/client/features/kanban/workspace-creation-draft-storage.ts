import { z } from 'zod';
import { sessionLaunchSelectionSnapshotSchema } from '@/client/features/session-selection';
import { AttachmentSchema } from '@/shared/websocket';

export const workspaceCreationDraftSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string().min(1),
  prompt: z.string(),
  attachments: z.array(AttachmentSchema),
  ratchetEnabled: z.boolean(),
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
    mode: 'STANDARD',
    cadence: 'DAILY',
    scheduledTime: '',
  };
}

export interface WorkspaceDraftSnapshot {
  draft: WorkspaceCreationDraft | null;
  isRestoring: boolean;
  persistenceError: string | null;
}
interface Entry {
  snapshot: WorkspaceDraftSnapshot;
  listeners: Set<() => void>;
  loading?: Promise<WorkspaceCreationDraft | null>;
  queue: Promise<unknown>;
  cleared: Set<string>;
}
const entries = new Map<string, Entry>();
function entryFor(projectId: string): Entry {
  let entry = entries.get(projectId);
  if (!entry) {
    entry = {
      snapshot: { draft: null, isRestoring: true, persistenceError: null },
      listeners: new Set(),
      queue: Promise.resolve(),
      cleared: new Set(),
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
      const request = indexedDB.open('factory-factory-workspace-drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
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
    const transaction = database.transaction('drafts', mode);
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
      action(transaction.objectStore('drafts'), (value) => {
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
      const draft = raw === undefined ? null : workspaceCreationDraftSchema.parse(raw);
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
  // Publish before any await: navigating away immediately must retain this edit.
  publish(entry, { draft, isRestoring: false });
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
export function clearWorkspaceCreationDraft(
  projectId: string,
  expectedRevision: string
): Promise<boolean> {
  const entry = entryFor(projectId);
  entry.cleared.add(expectedRevision);
  const matches = entry.snapshot.draft?.revision === expectedRevision;
  if (matches) {
    publish(entry, { draft: null, isRestoring: false });
  }
  return enqueue(entry, async () => {
    try {
      const cleared = await transact<boolean>('readwrite', (store, result) => {
        const request = store.get(projectId);
        request.onsuccess = () => {
          const parsed = workspaceCreationDraftSchema.safeParse(request.result);
          const matching = parsed.success && parsed.data.revision === expectedRevision;
          if (matching) {
            store.delete(projectId);
          }
          result(matching);
        };
      });
      publish(entry, { persistenceError: null });
      return cleared || matches;
    } catch (cause) {
      const message = 'Your saved draft could not be cleared. It may return after a refresh.';
      publish(entry, { persistenceError: message });
      throw new Error(message, { cause });
    }
  });
}
