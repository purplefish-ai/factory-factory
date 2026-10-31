import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  clearWorkspaceCreationDraft,
  createWorkspaceCreationDraft,
  getWorkspaceCreationDraftSnapshot,
  loadWorkspaceCreationDraft,
  saveWorkspaceCreationDraft,
  subscribeWorkspaceCreationDraft,
  type WorkspaceCreationDraft,
} from './workspace-creation-draft-storage';

type DraftPatch = Partial<Omit<WorkspaceCreationDraft, 'schemaVersion' | 'revision'>>;
export function useWorkspaceCreationDraft(projectId: string) {
  const [emptyDraft] = useState(createWorkspaceCreationDraft);
  const subscribe = useCallback(
    (listener: () => void) => subscribeWorkspaceCreationDraft(projectId, listener),
    [projectId]
  );
  const getSnapshot = useCallback(() => getWorkspaceCreationDraftSnapshot(projectId), [projectId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    void loadWorkspaceCreationDraft(projectId).catch(() => undefined);
  }, [projectId]);
  // Captures the project, not a mutable ref: file conversions finishing after a
  // project switch still belong to the project where they started.
  const updateDraft = useCallback(
    (patch: DraftPatch | ((draft: WorkspaceCreationDraft) => DraftPatch)) => {
      const current = getWorkspaceCreationDraftSnapshot(projectId).draft ?? emptyDraft;
      const next = {
        ...current,
        ...(typeof patch === 'function' ? patch(current) : patch),
        revision: crypto.randomUUID(),
      };
      void saveWorkspaceCreationDraft(projectId, next).catch(() => undefined);
    },
    [projectId, emptyDraft]
  );
  const captureDraft = useCallback(() => {
    const draft = getWorkspaceCreationDraftSnapshot(projectId).draft ?? emptyDraft;
    return { projectId, revision: draft.revision };
  }, [projectId, emptyDraft]);
  const clearSubmittedDraft = useCallback(
    (revision: string) => clearWorkspaceCreationDraft(projectId, revision),
    [projectId]
  );
  return {
    ...snapshot,
    draft: snapshot.draft ?? emptyDraft,
    hasDraft: snapshot.draft !== null,
    updateDraft,
    captureDraft,
    clearSubmittedDraft,
  };
}
