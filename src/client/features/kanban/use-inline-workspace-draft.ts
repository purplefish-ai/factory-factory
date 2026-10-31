import { useCallback, useEffect } from 'react';
import { useSessionLaunchSelection } from '@/client/features/session-selection';
import { useWorkspaceCreationDraft } from './use-workspace-creation-draft';
import { useWorkspaceCreationSubmission } from './use-workspace-creation-submission';
import type { WorkspaceCreationDraft } from './workspace-creation-draft-storage';

/** Bind editor setters to a project, including asynchronous attachment work. */
export function useInlineWorkspaceDraft(
  projectId: string,
  defaultRatchetEnabled: boolean | undefined
) {
  const recovery = useWorkspaceCreationDraft(projectId);
  const { draft, updateDraft, hasDraft } = recovery;
  const { isPending } = useWorkspaceCreationSubmission(projectId);
  const ratchetEnabled = draft.ratchetInitialized
    ? draft.ratchetEnabled
    : (defaultRatchetEnabled ?? false);
  // Passive defaults must preserve the submitted revision until the request finishes.
  useEffect(() => {
    if (
      !isPending &&
      hasDraft &&
      !draft.ratchetInitialized &&
      defaultRatchetEnabled !== undefined
    ) {
      updateDraft({ ratchetEnabled: defaultRatchetEnabled, ratchetInitialized: true });
    }
  }, [isPending, hasDraft, draft.ratchetInitialized, defaultRatchetEnabled, updateDraft]);
  const launchSelection = useSessionLaunchSelection(projectId, {
    snapshot: draft.launchSelection,
    onChange: (launchSelection) =>
      updateDraft({
        launchSelection,
        ratchetEnabled,
        ratchetInitialized: draft.ratchetInitialized || defaultRatchetEnabled !== undefined,
      }),
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
        ratchetEnabled: previous.ratchetInitialized
          ? previous.ratchetEnabled
          : (defaultRatchetEnabled ?? false),
        ratchetInitialized:
          previous.ratchetInitialized ||
          defaultRatchetEnabled !== undefined ||
          key === 'ratchetEnabled',
        launchSelection: previous.launchSelection ?? snapshot,
        [key]: typeof value === 'function' ? value(previous[key]) : value,
      }));
    },
    [updateDraft, defaultRatchetEnabled, snapshot]
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
