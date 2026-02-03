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
  const isInitializing =
    isInitStatusPending || status === 'NEW' || status === 'PROVISIONING' || status === 'FAILED';

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

/**
 * Hook to handle pending prompts stored in sessionStorage.
 * Used when creating a workspace with a default prompt that should be sent
 * once the session is ready.
 */
export function usePendingPrompt({
  selectedDbSessionId,
  isSessionReady,
  sendMessage,
}: {
  selectedDbSessionId: string | null;
  isSessionReady: boolean;
  sendMessage: (text: string) => void;
}) {
  const wasSessionReadyRef = useRef(isSessionReady);
  const hasSentPromptRef = useRef(false);
  const prevSessionIdRef = useRef(selectedDbSessionId);

  useEffect(() => {
    // Reset state when session ID changes
    if (prevSessionIdRef.current !== selectedDbSessionId) {
      hasSentPromptRef.current = false;
      wasSessionReadyRef.current = false;
      prevSessionIdRef.current = selectedDbSessionId;
    }

    if (!selectedDbSessionId) {
      return;
    }

    const transitionedToReady = !wasSessionReadyRef.current && isSessionReady;
    wasSessionReadyRef.current = isSessionReady;

    // Only send on transition to ready, and only once
    if (transitionedToReady && !hasSentPromptRef.current) {
      const storageKey = `pending-prompt-${selectedDbSessionId}`;
      const pendingPrompt = sessionStorage.getItem(storageKey);

      if (pendingPrompt) {
        hasSentPromptRef.current = true;
        sessionStorage.removeItem(storageKey);
        // Small delay to ensure the UI is fully ready
        setTimeout(() => {
          sendMessage(pendingPrompt);
        }, 100);
      }
    }
  }, [selectedDbSessionId, isSessionReady, sendMessage]);
}
