import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { TranscriptPosition } from '@/client/features/chat';
import { useWorkspacePanel } from './workspace-panel-context';

interface UseChatTranscriptPersistenceOptions {
  workspaceId: string | null;
  sessionId: string | null;
}

/** Adapts committed transcript snapshots to workspace-owned v1 scroll storage. */
export function useChatTranscriptPersistence({
  workspaceId,
  sessionId,
}: UseChatTranscriptPersistenceOptions) {
  const { scrollLoadedWorkspaceId, getScrollState, createScrollStateWriter, clearScrollState } =
    useWorkspacePanel();
  const ready =
    workspaceId !== null && sessionId !== null && scrollLoadedWorkspaceId === workspaceId;
  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const scope = useMemo(() => {
    const tabId = sessionId === null ? null : `chat-${sessionId}`;
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
  }, [sessionId, ready, getScrollState, createScrollStateWriter]);

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

  const clearSession = useCallback(
    (closedSessionId: string) => {
      if (mountedRef.current && workspaceId !== null && scrollLoadedWorkspaceId === workspaceId) {
        clearScrollState(`chat-${closedSessionId}`);
      }
    },
    [workspaceId, scrollLoadedWorkspaceId, clearScrollState]
  );

  return { ready, initialPosition: scope.initialPosition, onPositionChange, clearSession };
}
