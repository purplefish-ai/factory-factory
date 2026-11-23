import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import type { TranscriptPosition, TranscriptScrollOptions } from '@/client/features/chat';

/** Transcript positions per workspace session, and revisions that retire stale writers. */
export interface QuickChatScrollMemory {
  positions: Map<string, TranscriptPosition>;
  revisions: Map<string, number>;
}

export function createQuickChatScrollMemory(): QuickChatScrollMemory {
  return { positions: new Map(), revisions: new Map() };
}

/**
 * Sheet-owned memory survives content unmount, without adding durable storage. The
 * board's Quick Chat sheet passes `memory` because its body, which calls this hook,
 * unmounts each time the sheet closes.
 */
export function useQuickChatScroll(
  workspaceId: string | null,
  sessionId: string | null,
  runtimeSessionId: string | null,
  memory?: QuickChatScrollMemory
) {
  const [ownMemory] = useState(createQuickChatScrollMemory);
  const { positions, revisions } = memory ?? ownMemory;
  const identity = `${workspaceId ?? 'none'}/quick/${sessionId ?? 'none'}`;
  const revision = revisions.get(identity) ?? 0;
  const scope = useMemo(() => ({ active: false, identity, revision }), [identity, revision]);
  useLayoutEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);
  const onPositionChange = useCallback(
    (position: TranscriptPosition) => {
      // The scope is inactive before mount, after unmount and once superseded.
      if (scope.active && (revisions.get(identity) ?? 0) === revision) {
        positions.set(identity, position);
      }
    },
    [identity, revision, scope, positions, revisions]
  );
  const revokeSession = useCallback(
    (closedId: string) => {
      const key = `${workspaceId ?? 'none'}/quick/${closedId}`;
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
    },
    [workspaceId, revisions]
  );
  const clearSession = useCallback(
    (closedId: string) => {
      const key = `${workspaceId ?? 'none'}/quick/${closedId}`;
      revokeSession(closedId);
      positions.delete(key);
    },
    [workspaceId, revokeSession, positions]
  );
  const transcriptScroll: TranscriptScrollOptions = {
    identity,
    active: workspaceId !== null,
    ready: workspaceId !== null && sessionId !== null && runtimeSessionId === sessionId,
    initialIntent: 'following',
    initialPosition: positions.get(identity) ?? null,
    onPositionChange,
  };
  return { transcriptScroll, clearSession, revokeSession };
}
