import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChatWebSocket, useSessionCollectionCommands } from '@/client/features/chat';
import { useSessionLaunchSelection } from '@/client/features/session-selection';
import { trpc } from '@/client/lib/trpc';
import { useAutoScroll } from '@/hooks/use-auto-scroll';

function isPendingCreatedSelection(
  pendingSession: { id: string; workspaceId: string } | null,
  workspaceId: string,
  selectedSessionId: string | null
) {
  return pendingSession?.workspaceId === workspaceId && pendingSession.id === selectedSessionId;
}

export function useQuickChat(workspaceId: string | null) {
  const {
    data: workspace,
    error: workspaceError,
    refetch: refetchWorkspace,
  } = trpc.workspace.get.useQuery(
    { id: workspaceId ?? '' },
    { enabled: !!workspaceId, staleTime: Number.POSITIVE_INFINITY }
  );
  const launchSelection = useSessionLaunchSelection(workspaceId, {
    defaultProvider: workspace?.defaultSessionProvider,
    ready: workspace !== undefined,
    error: !workspace && workspaceError ? 'Could not load workspace defaults' : undefined,
    onRetry: () => {
      void refetchWorkspace();
    },
  });
  const viewportRef = useRef<HTMLDivElement>(null);
  const { onScroll, isNearBottom, scrollToBottom } = useAutoScroll(viewportRef);

  const { data: sessions } = trpc.session.listSessions.useQuery(
    { workspaceId: workspaceId ?? '' },
    { enabled: !!workspaceId, staleTime: 0, refetchOnWindowFocus: false }
  );

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const pendingCreatedSessionRef = useRef<{ id: string; workspaceId: string } | null>(null);

  // Auto-select first session; reset when workspace changes
  useEffect(() => {
    if (!workspaceId) {
      pendingCreatedSessionRef.current = null;
      setSelectedSessionId(null);
      return;
    }
    if (!sessions) {
      return;
    }

    const currentValid = sessions.some((session) => session.id === selectedSessionId);
    const pendingCreatedSession = pendingCreatedSessionRef.current;
    const currentIsPending = isPendingCreatedSelection(
      pendingCreatedSession,
      workspaceId,
      selectedSessionId
    );

    if (currentValid && currentIsPending) {
      pendingCreatedSessionRef.current = null;
    }
    if (currentValid) {
      return;
    }
    if (currentIsPending) {
      return;
    }
    if (sessions.length === 0) {
      setSelectedSessionId(null);
      return;
    }

    const firstSession = sessions[0];
    if (firstSession) {
      setSelectedSessionId(firstSession.id);
    }
  }, [workspaceId, sessions, selectedSessionId]);

  const chatState = useChatWebSocket({
    dbSessionId: workspaceId ? selectedSessionId : null,
  });

  const activeWorkspaceRef = useRef(workspaceId);
  useLayoutEffect(() => {
    activeWorkspaceRef.current = workspaceId;
  }, [workspaceId]);
  const {
    createSession,
    deleteSession,
    createChat: handleNewChat,
    createQuickAction: handleQuickAction,
  } = useSessionCollectionCommands({
    workspaceId,
    sessions,
    creationDefaults: launchSelection.creationDefaults,
    canCreate: launchSelection.ready,
    onCreated: (session, originatingWorkspaceId) => {
      if (activeWorkspaceRef.current !== originatingWorkspaceId) {
        return;
      }
      pendingCreatedSessionRef.current = { id: session.id, workspaceId: originatingWorkspaceId };
      setSelectedSessionId(session.id);
      launchSelection.reset();
    },
  });

  const handleCloseSession = useCallback(
    (dbSessionId: string) => {
      if (!sessions || sessions.length === 0) {
        return;
      }
      const sessionIndex = sessions.findIndex((s) => s.id === dbSessionId);
      if (sessionIndex === -1) {
        return;
      }
      const isSelectedSession = dbSessionId === selectedSessionId;
      deleteSession.mutate({ id: dbSessionId });

      if (isSelectedSession && sessions.length > 1) {
        const nextSession = sessions[sessionIndex + 1] ?? sessions[sessionIndex - 1];
        setSelectedSessionId(nextSession?.id ?? null);
      } else if (sessions.length === 1) {
        setSelectedSessionId(null);
      }
    },
    [sessions, selectedSessionId, deleteSession]
  );

  return {
    sessions: sessions ?? [],
    selectedSessionId,
    setSelectedSessionId,
    chatState,
    viewportRef,
    onScroll,
    isNearBottom,
    scrollToBottom,
    handleNewChat,
    handleCloseSession,
    handleQuickAction,
    isCreatingSession: createSession.isPending,
    launchSelection,
  };
}
