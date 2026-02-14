import { useCallback, useEffect, useRef, useState } from 'react';

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
    // agentSessions, etc. refresh immediately and the chat UI can connect.
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

  // Script failed after worktree was created — non-blocking banner with retry
  const isScriptFailed = status === 'FAILED' && hasWorktreePath;

  return {
    workspaceInitStatus,
    isInitStatusPending,
    isScriptFailed,
  };
}

const SESSION_TAB_STORAGE_PREFIX = 'workspace-selected-session-';

interface ResolveSelectedSessionIdInput {
  currentSelectedDbSessionId: string | null;
  persistedSessionId: string | null;
  initialDbSessionId: string | null;
  sessionIds: string[];
}

export function resolveSelectedSessionId({
  currentSelectedDbSessionId,
  persistedSessionId,
  initialDbSessionId,
  sessionIds,
}: ResolveSelectedSessionIdInput): string | null {
  if (sessionIds.length === 0) {
    return currentSelectedDbSessionId;
  }

  if (currentSelectedDbSessionId && sessionIds.includes(currentSelectedDbSessionId)) {
    return currentSelectedDbSessionId;
  }

  if (persistedSessionId && sessionIds.includes(persistedSessionId)) {
    return persistedSessionId;
  }

  if (initialDbSessionId && sessionIds.includes(initialDbSessionId)) {
    return initialDbSessionId;
  }

  return sessionIds[0] ?? null;
}

export function useSelectedSessionId(
  workspaceId: string,
  initialDbSessionId: string | null,
  sessionIds: string[]
) {
  const storageKey = `${SESSION_TAB_STORAGE_PREFIX}${workspaceId}`;

  const [selectedDbSessionId, setSelectedDbSessionIdRaw] = useState<string | null>(() => {
    const stored = localStorage.getItem(storageKey);
    return stored ?? initialDbSessionId;
  });

  useEffect(() => {
    const persistedSessionId = localStorage.getItem(storageKey);
    const resolved = resolveSelectedSessionId({
      currentSelectedDbSessionId: selectedDbSessionId,
      persistedSessionId,
      initialDbSessionId,
      sessionIds,
    });
    if (resolved !== selectedDbSessionId) {
      setSelectedDbSessionIdRaw(resolved);
    }
  }, [initialDbSessionId, selectedDbSessionId, sessionIds, storageKey]);

  const setSelectedDbSessionId = useCallback(
    (id: string | null) => {
      setSelectedDbSessionIdRaw(id);
      if (id) {
        localStorage.setItem(storageKey, id);
      } else {
        localStorage.removeItem(storageKey);
      }
    },
    [storageKey]
  );

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
