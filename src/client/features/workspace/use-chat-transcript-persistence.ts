import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { TranscriptPosition } from '@/client/features/chat';
import { useWorkspacePanel } from './workspace-panel-context';

interface UseChatTranscriptPersistenceOptions {
  workspaceId: string | null;
  sessionId: string | null;
}

/** Private workspace adapter for any transcript tab using v1 scroll storage. */
export function useTranscriptPositionPersistence({
  workspaceId,
  tabId,
}: {
  workspaceId: string | null;
  tabId: string | null;
}) {
  const { scrollLoadedWorkspaceId, getScrollState, createScrollStateWriter, clearScrollState } =
    useWorkspacePanel();
  const ready = workspaceId !== null && tabId !== null && scrollLoadedWorkspaceId === workspaceId;
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const scope = useMemo(() => {
    const saved = ready && tabId ? getScrollState(tabId, 'chat') : null;
    const initialPosition: TranscriptPosition | null = saved
      ? (saved.chatPosition ?? {
          intent: saved.stickToBottom === true ? 'following' : 'reading',
          top: saved.top,
          left: saved.left,
        })
      : null;
    return {
      active: false,
      initialPosition,
      write: ready && tabId ? createScrollStateWriter(tabId, 'chat') : null,
    };
  }, [tabId, ready, getScrollState, createScrollStateWriter]);

  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);

  const onPositionChange = useCallback(
    (position: TranscriptPosition) => {
      if (scope.active) {
        scope.write?.({ top: position.top, left: position.left, chatPosition: position });
      }
    },
    [scope]
  );

  const clearTab = useCallback(
    (closedTabId: string) => {
      if (mountedRef.current && workspaceId !== null && scrollLoadedWorkspaceId === workspaceId) {
        clearScrollState(closedTabId);
      }
    },
    [workspaceId, scrollLoadedWorkspaceId, clearScrollState]
  );

  return { ready, initialPosition: scope.initialPosition, onPositionChange, clearTab };
}

/** Adapts committed chat snapshots while retaining the session-close capability. */
export function useChatTranscriptPersistence({
  workspaceId,
  sessionId,
}: UseChatTranscriptPersistenceOptions) {
  const { clearTab, ...persistence } = useTranscriptPositionPersistence({
    workspaceId,
    tabId: sessionId === null ? null : `chat-${sessionId}`,
  });
  const clearSession = useCallback(
    (closedSessionId: string) => {
      clearTab(`chat-${closedSessionId}`);
    },
    [clearTab]
  );
  return { ...persistence, clearSession };
}
