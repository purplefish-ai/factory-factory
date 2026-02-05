import { useEffect, useRef, useState } from 'react';

import { trpc } from '@/frontend/lib/trpc';

import type { useWorkspaceData } from './use-workspace-detail';

export function useWorkspaceInitStatus(
  workspaceId: string,
  workspace: ReturnType<typeof useWorkspaceData>['workspace'],
  utils: ReturnType<typeof trpc.useUtils>
) {
  const { data: workspaceInitStatus, isPending: isInitStatusPending } =
    trpc.workspace.getInitStatus.useQuery(
      { id: workspaceId },
      {
        refetchInterval: (query) => {
          const status = query.state.data?.status;
          return status === 'READY' || status === 'FAILED' || status === 'ARCHIVED' ? false : 1000;
        },
      }
    );

  const prevInitStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const currentStatus = workspaceInitStatus?.status;
    const prevStatus = prevInitStatusRef.current;

    if (currentStatus === 'READY') {
      const isTransitionToReady = prevStatus !== undefined && prevStatus !== 'READY';
      const isStaleOnFirstLoad = prevStatus === undefined && !workspace?.worktreePath;

      if (isTransitionToReady || isStaleOnFirstLoad) {
        utils.workspace.get.invalidate({ id: workspaceId });
      }
    }

    prevInitStatusRef.current = currentStatus;
  }, [workspaceInitStatus?.status, workspaceId, utils, workspace?.worktreePath]);

  const status = workspaceInitStatus?.status;
  // Only show blocking overlay for NEW state (brief moment before PROVISIONING starts)
  // PROVISIONING: Init Logs tab shows progress (non-blocking)
  // FAILED: InitFailedBanner shows error (non-blocking)
  const isInitializing = isInitStatusPending || status === 'NEW';

  return { workspaceInitStatus, isInitStatusPending, isInitializing };
}

export function useSelectedSessionId(initialDbSessionId: string | null) {
  const [selectedDbSessionId, setSelectedDbSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (initialDbSessionId && selectedDbSessionId === null) {
      setSelectedDbSessionId(initialDbSessionId);
    }
  }, [initialDbSessionId, selectedDbSessionId]);

  return { selectedDbSessionId, setSelectedDbSessionId };
}

export function useAutoFocusChatInput({
  workspaceLoading,
  workspace,
  selectedDbSessionId,
  activeTabId,
  loadingSession,
  inputRef,
}: {
  workspaceLoading: boolean;
  workspace: ReturnType<typeof useWorkspaceData>['workspace'];
  selectedDbSessionId: string | null;
  activeTabId: string | null;
  loadingSession: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const hasFocusedOnEntryRef = useRef(false);
  useEffect(() => {
    if (
      !(hasFocusedOnEntryRef.current || workspaceLoading) &&
      workspace &&
      selectedDbSessionId &&
      activeTabId === 'chat' &&
      !loadingSession
    ) {
      hasFocusedOnEntryRef.current = true;
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [selectedDbSessionId, activeTabId, loadingSession, workspaceLoading, workspace, inputRef]);
}
