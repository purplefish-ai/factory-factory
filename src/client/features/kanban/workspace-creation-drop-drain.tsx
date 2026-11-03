import { useEffect, useSyncExternalStore } from 'react';
import { useWorkspaceCreationDraft } from './use-workspace-creation-draft';
import {
  getPendingWorkspaceCreationDropProjectIds,
  subscribeWorkspaceCreationDrops,
  takeWorkspaceCreationAttachments,
} from './workspace-creation-drop-queue';

/** Appends queued drop attachments to the project's creation draft; renders nothing. */
export function WorkspaceCreationDropDrain({ projectId }: { projectId: string }) {
  const { updateDraft } = useWorkspaceCreationDraft(projectId);
  const pending = useSyncExternalStore(subscribeWorkspaceCreationDrops, () =>
    getPendingWorkspaceCreationDropProjectIds().includes(projectId)
  );
  useEffect(() => {
    if (!pending) {
      return;
    }
    const attachments = takeWorkspaceCreationAttachments(projectId);
    if (attachments.length > 0) {
      updateDraft((draft) => ({ attachments: [...draft.attachments, ...attachments] }));
    }
  }, [pending, projectId, updateDraft]);
  return null;
}
