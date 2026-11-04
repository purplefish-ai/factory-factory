import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  clearWorkspaceCreationDraft,
  createWorkspaceCreationDraft,
  discardWorkspaceCreationDraft,
  getWorkspaceCreationDraftSnapshot,
  loadWorkspaceCreationDraft,
  saveWorkspaceCreationDraft,
  subscribeWorkspaceCreationDraft,
  type WorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

type DraftPatch = Partial<Omit<WorkspaceCreationDraft, 'schemaVersion' | 'revision'>>;
export function useWorkspaceCreationDraft(projectId: string, enabled = true, initialPrompt = '') {
  const [emptyDraft] = useState(() => ({
    ...createWorkspaceCreationDraft(),
    prompt: initialPrompt,
  }));
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? subscribeWorkspaceCreationDraft(projectId, listener) : () => undefined,
    [projectId, enabled]
  );
  const getSnapshot = useCallback(() => getWorkspaceCreationDraftSnapshot(projectId), [projectId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (enabled) {
      void loadWorkspaceCreationDraft(projectId).catch(() => undefined);
    }
  }, [projectId, enabled]);
  // Captures the project, not a mutable ref: file conversions finishing after a
  // project switch still belong to the project where they started.
  const updateDraft = useCallback(
    (patch: DraftPatch | ((draft: WorkspaceCreationDraft) => DraftPatch)) => {
      if (!enabled) {
        return;
      }
      const currentSnapshot = getWorkspaceCreationDraftSnapshot(projectId);
      if (currentSnapshot.generation !== snapshot.generation) {
        return;
      }
      if (currentSnapshot.isRestoring) {
        void loadWorkspaceCreationDraft(projectId)
          .catch(() => undefined)
          .then(() => {
            updateDraft(patch);
          });
        return;
      }
      const current = currentSnapshot.draft ?? emptyDraft;
      const next = {
        ...current,
        ...(typeof patch === 'function' ? patch(current) : patch),
        revision: crypto.randomUUID(),
      };
      void saveWorkspaceCreationDraft(projectId, next).catch(() => undefined);
    },
    [projectId, emptyDraft, snapshot.generation, enabled]
  );
  const captureDraft = useCallback(() => {
    const draft = getWorkspaceCreationDraftSnapshot(projectId).draft ?? emptyDraft;
    return { projectId, revision: draft.revision };
  }, [projectId, emptyDraft]);
  const clearSubmittedDraft = useCallback(
    (revision: string) => clearWorkspaceCreationDraft(projectId, revision),
    [projectId]
  );
  const discardDraft = useCallback(() => discardWorkspaceCreationDraft(projectId), [projectId]);
  return {
    ...snapshot,
    discardDraft,
    draft: snapshot.draft ?? emptyDraft,
    hasDraft: snapshot.draft !== null,
    updateDraft,
    captureDraft,
    clearSubmittedDraft,
  };
}
