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
  const prevHasWorktreePathRef = useRef(false);
  const hasWorktreePath = workspaceInitStatus?.hasWorktreePath ?? false;

  useEffect(() => {
    const currentStatus = workspaceInitStatus?.status;
    const prevStatus = prevInitStatusRef.current;

    // Invalidate workspace data when worktree becomes available so worktreePath,
    // claudeSessions, etc. refresh immediately and the chat UI can connect.
    if (hasWorktreePath && !prevHasWorktreePathRef.current) {
      utils.workspace.get.invalidate({ id: workspaceId });
    }
    prevHasWorktreePathRef.current = hasWorktreePath;

    if (currentStatus === 'READY') {
      const isTransitionToReady = prevStatus !== undefined && prevStatus !== 'READY';
      const isStaleOnFirstLoad = prevStatus === undefined && !workspace?.worktreePath;

      if (isTransitionToReady || isStaleOnFirstLoad) {
        utils.workspace.get.invalidate({ id: workspaceId });
      }
    }

    prevInitStatusRef.current = currentStatus;
  }, [workspaceInitStatus?.status, hasWorktreePath, workspaceId, utils, workspace?.worktreePath]);

  const status = workspaceInitStatus?.status;

  // Non-blocking: worktree exists but script still running
  const isScriptRunning = status === 'PROVISIONING' && hasWorktreePath;

  // Script failed after worktree was created — non-blocking banner with retry
  const isScriptFailed = status === 'FAILED' && hasWorktreePath;

  return {
    workspaceInitStatus,
    isInitStatusPending,
    isScriptRunning,
    isScriptFailed,
  };
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
