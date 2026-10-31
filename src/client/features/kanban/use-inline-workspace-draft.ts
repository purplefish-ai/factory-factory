import { useCallback } from 'react';
import { useSessionLaunchSelection } from '@/client/features/session-selection';
import { useWorkspaceCreationDraft } from './use-workspace-creation-draft';
import type { WorkspaceCreationDraft } from './workspace-creation-draft-storage';

/** Bind editor setters to a project, including asynchronous attachment work. */
export function useInlineWorkspaceDraft(projectId: string, defaultRatchetEnabled: boolean) {
  const recovery = useWorkspaceCreationDraft(projectId);
  const { draft, updateDraft, hasDraft } = recovery;
  const ratchetEnabled = hasDraft ? draft.ratchetEnabled : defaultRatchetEnabled;
  const launchSelection = useSessionLaunchSelection(projectId, {
    snapshot: draft.launchSelection,
    onChange: (launchSelection) => updateDraft({ launchSelection, ratchetEnabled }),
  });
  const snapshot = launchSelection.snapshot;
  const setField = useCallback(
    <K extends 'prompt' | 'attachments' | 'ratchetEnabled' | 'mode' | 'cadence' | 'scheduledTime'>(
      key: K,
      value:
        | WorkspaceCreationDraft[K]
        | ((previous: WorkspaceCreationDraft[K]) => WorkspaceCreationDraft[K])
    ) => {
      updateDraft((previous) => ({
        ratchetEnabled: previous.launchSelection ? previous.ratchetEnabled : ratchetEnabled,
        launchSelection: previous.launchSelection ?? snapshot,
        [key]: typeof value === 'function' ? value(previous[key]) : value,
      }));
    },
    [updateDraft, ratchetEnabled, snapshot]
  );
  return {
    ...recovery,
    launchSelection,
    ratchetEnabled,
    setInitialPrompt: useCallback((value: string) => setField('prompt', value), [setField]),
    setAttachments: useCallback(
      (
        value:
          | WorkspaceCreationDraft['attachments']
          | ((
              previous: WorkspaceCreationDraft['attachments']
            ) => WorkspaceCreationDraft['attachments'])
      ) => setField('attachments', value),
      [setField]
    ),
    setRatchetEnabled: (value: boolean) => setField('ratchetEnabled', value),
    setMode: (value: WorkspaceCreationDraft['mode']) => setField('mode', value),
    setCadence: (value: WorkspaceCreationDraft['cadence']) => setField('cadence', value),
    setScheduledTime: (value: string) => setField('scheduledTime', value),
  };
}
