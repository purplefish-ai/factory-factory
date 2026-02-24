import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { useChatWebSocket } from '@/components/chat';
import { useAutoScroll } from '@/hooks/use-auto-scroll';

export function useQuickChat(workspaceId: string | null) {
  const utils = trpc.useUtils();
  const viewportRef = useRef<HTMLDivElement>(null);
  const { onScroll, isNearBottom, scrollToBottom } = useAutoScroll(viewportRef);

  const { data: sessions } = trpc.session.listSessions.useQuery(
    { workspaceId: workspaceId ?? '' },
    { enabled: !!workspaceId, staleTime: 0, refetchOnWindowFocus: false }
  );

  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Auto-select first session; reset when workspace changes
  useEffect(() => {
    if (!workspaceId) {
      setSelectedSessionId(null);
      return;
    }
    if (sessions && sessions.length > 0) {
      // Keep current selection if it's still valid
      const currentValid = sessions.some((s) => s.id === selectedSessionId);
      if (!currentValid) {
        const firstSession = sessions[0];
        if (firstSession) {
          setSelectedSessionId(firstSession.id);
        }
      }
    }
  }, [workspaceId, sessions, selectedSessionId]);

  const chatState = useChatWebSocket({
    dbSessionId: workspaceId ? selectedSessionId : null,
  });

  // Session creation mutations
  const createSession = trpc.session.createSession.useMutation({
    onSuccess: () => {
      if (workspaceId) {
        utils.session.listSessions.invalidate({ workspaceId });
      }
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to create session');
    },
  });
  const startSession = trpc.session.startSession.useMutation();
  const deleteSession = trpc.session.deleteSession.useMutation({
    onMutate: async ({ id }) => {
      await utils.session.listSessions.cancel({ workspaceId: workspaceId ?? '' });
      const previousSessions = utils.session.listSessions.getData({
        workspaceId: workspaceId ?? '',
      });
      utils.session.listSessions.setData({ workspaceId: workspaceId ?? '' }, (old) =>
        old?.filter((s) => s.id !== id)
      );
      return { previousSessions };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousSessions) {
        utils.session.listSessions.setData(
          { workspaceId: workspaceId ?? '' },
          context.previousSessions
        );
      }
    },
    onSettled: () => {
      if (workspaceId) {
        utils.session.listSessions.invalidate({ workspaceId });
      }
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

  const getNextChatName = useCallback(() => {
    const existingNumbers = (sessions ?? [])
      .map((s) => {
        const match = s.name?.match(/^Chat (\d+)$/);
        return match ? Number.parseInt(match[1] as string, 10) : 0;
      })
      .filter((n) => n > 0);
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    return `Chat ${nextNumber}`;
  }, [sessions]);

  const handleNewChat = useCallback(() => {
    if (!workspaceId) {
      return;
    }
    const name = getNextChatName();
    createSession.mutate(
      { workspaceId, workflow: 'followup', model: '', name },
      {
        onSuccess: (session) => {
          const previousSessionId = selectedSessionId;
          startSession.mutate(
            { id: session.id, initialPrompt: '' },
            {
              onSuccess: () => {
                setSelectedSessionId(session.id);
              },
              onError: (error) => {
                toast.error(error.message || 'Failed to start session');
                setSelectedSessionId(previousSessionId);
              },
            }
          );
        },
      }
    );
  }, [workspaceId, getNextChatName, createSession, startSession, selectedSessionId]);

  const handleQuickAction = useCallback(
    (name: string, prompt: string) => {
      if (!workspaceId) {
        return;
      }
      const previousSessionId = selectedSessionId;
      createSession.mutate(
        { workspaceId, workflow: 'followup', model: '', name, initialMessage: prompt },
        {
          onSuccess: (session) => {
            startSession.mutate(
              { id: session.id, initialPrompt: '' },
              {
                onSuccess: () => {
                  setSelectedSessionId(session.id);
                },
                onError: (error) => {
                  toast.error(error.message || 'Failed to start session');
                  setSelectedSessionId(previousSessionId);
                },
              }
            );
          },
        }
      );
    },
    [workspaceId, createSession, startSession, selectedSessionId]
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
  };
}
