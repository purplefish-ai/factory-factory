import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { TranscriptPosition, TranscriptScrollOptions } from '@/client/features/chat';

/** Sheet-owned memory survives content unmount, without adding durable storage. */
export function useQuickChatScroll(
  workspaceId: string | null,
  sessionId: string | null,
  runtimeSessionId: string | null
) {
  const positions = useRef(new Map<string, TranscriptPosition>());
  const revisions = useRef(new Map<string, number>());
  const identity = `${workspaceId ?? 'none'}/quick/${sessionId ?? 'none'}`;
  const revision = revisions.current.get(identity) ?? 0;
  const scope = useMemo(() => ({ active: false, identity, revision }), [identity, revision]);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  const onPositionChange = useCallback(
    (position: TranscriptPosition) => {
      if (mounted.current && scope.active && (revisions.current.get(identity) ?? 0) === revision) {
        positions.current.set(identity, position);
      }
    },
    [identity, revision, scope]
  );
  const revokeSession = useCallback(
    (closedId: string) => {
      const key = `${workspaceId ?? 'none'}/quick/${closedId}`;
      revisions.current.set(key, (revisions.current.get(key) ?? 0) + 1);
    },
    [workspaceId]
  );
  const clearSession = useCallback(
    (closedId: string) => {
      const key = `${workspaceId ?? 'none'}/quick/${closedId}`;
      revokeSession(closedId);
      positions.current.delete(key);
    },
    [workspaceId, revokeSession]
  );
  const transcriptScroll: TranscriptScrollOptions = {
    identity,
    active: workspaceId !== null,
    ready: workspaceId !== null && sessionId !== null && runtimeSessionId === sessionId,
    initialIntent: 'following',
    initialPosition: positions.current.get(identity) ?? null,
    onPositionChange,
  };
  return { transcriptScroll, clearSession, revokeSession };
}
