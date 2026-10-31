import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import {
  clearWorkspaceCreationDraft,
  getWorkspaceCreationDraftSnapshot,
  pinWorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

export interface WorkspaceCreationSubmission {
  projectId: string;
  revision: string | null;
  id: string;
}
interface SubmissionState {
  pending: WorkspaceCreationSubmission | null;
  error: string | null;
}
interface Entry {
  state: SubmissionState;
  listeners: Set<() => void>;
  releaseRevision?: () => void;
}
// Request ownership survives composer navigation, but never another window.
const entries = new Map<string, Entry>();
function entryFor(projectId: string): Entry {
  let entry = entries.get(projectId);
  if (!entry) {
    entry = { state: { pending: null, error: null }, listeners: new Set() };
    entries.set(projectId, entry);
  }
  return entry;
}
function publish(entry: Entry, state: SubmissionState) {
  entry.state = state;
  entry.listeners.forEach((listener) => listener());
}
function finish(submission: WorkspaceCreationSubmission, error: string | null) {
  const entry = entryFor(submission.projectId);
  if (entry.state.pending?.id === submission.id) {
    entry.releaseRevision?.();
    entry.releaseRevision = undefined;
    publish(entry, { pending: null, error });
  }
}

/** Own a submission independently of whichever composer is currently mounted. */
export function useWorkspaceCreationSubmission(projectId: string) {
  const activeProject = useRef<string | null>(null);
  useLayoutEffect(() => {
    activeProject.current = projectId;
    return () => {
      activeProject.current = null;
    };
  }, [projectId]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryFor(projectId);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [projectId]
  );
  const getSnapshot = useCallback(() => entryFor(projectId).state, [projectId]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const begin = useCallback((): WorkspaceCreationSubmission | null => {
    const entry = entryFor(projectId);
    if (entry.state.pending) {
      return null;
    }
    const submission = {
      projectId,
      revision: getWorkspaceCreationDraftSnapshot(projectId).draft?.revision ?? null,
      id: crypto.randomUUID(),
    };
    if (submission.revision) {
      entry.releaseRevision = pinWorkspaceCreationDraft(projectId, submission.revision);
    }
    publish(entry, { pending: submission, error: null });
    return submission;
  }, [projectId]);
  const fail = useCallback((submission: WorkspaceCreationSubmission, error: string) => {
    finish(submission, error);
  }, []);
  const succeed = useCallback(async (submission: WorkspaceCreationSubmission): Promise<boolean> => {
    if (entryFor(submission.projectId).state.pending?.id !== submission.id) {
      return false;
    }
    try {
      if (submission.revision) {
        await clearWorkspaceCreationDraft(submission.projectId, submission.revision);
      }
      finish(submission, null);
      // Check after persistence too: a newer draft may have arrived during it.
      return (
        activeProject.current === submission.projectId &&
        getWorkspaceCreationDraftSnapshot(submission.projectId).draft === null
      );
    } catch {
      finish(
        submission,
        'Task created, but its saved draft could not be cleared. The saved draft may reappear after a refresh.'
      );
      return false;
    }
  }, []);
  return { isPending: state.pending !== null, error: state.error, begin, fail, succeed };
}
