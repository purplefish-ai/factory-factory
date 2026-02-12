import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { trpc } from '@/frontend/lib/trpc';

// Re-export useAutoScroll from shared hooks location
export { useAutoScroll } from '@/hooks/use-auto-scroll';

// =============================================================================
// Helpers
// =============================================================================

// =============================================================================
// useWorkspaceData - Fetches workspace and session data
// =============================================================================

interface UseWorkspaceDataOptions {
  workspaceId: string;
}

export function useWorkspaceData({ workspaceId }: UseWorkspaceDataOptions) {
  const utils = trpc.useUtils();

  // Increased staleTime to reduce unnecessary re-renders from background fetches
  const { data: workspace, isLoading: workspaceLoading } = trpc.workspace.get.useQuery(
    { id: workspaceId },
    {
      refetchInterval: 30_000, // Poll every 30s for background updates (worktreePath set on creation)
      staleTime: 10_000, // Data considered fresh for 10s
      refetchOnWindowFocus: false, // Don't refetch on tab focus
    }
  );

  // Expose invalidate function for external triggers (e.g., when session stops running)
  const invalidateWorkspace = useCallback(() => {
    utils.workspace.get.invalidate({ id: workspaceId });
  }, [utils, workspaceId]);

  // Sync PR status from GitHub on page load (if workspace has a PR)
  const syncPRStatus = trpc.workspace.syncPRStatus.useMutation({
    onSuccess: () => {
      // Refresh workspace data after PR sync
      utils.workspace.get.invalidate({ id: workspaceId });
    },
  });

  // Sync PR status once when workspace loads with a PR URL
  const hasSyncedRef = useRef(false);
  useEffect(() => {
    if (workspace?.prUrl && !hasSyncedRef.current && !syncPRStatus.isPending) {
      hasSyncedRef.current = true;
      syncPRStatus.mutate({ workspaceId });
    }
  }, [workspace?.prUrl, workspaceId, syncPRStatus]);

  const { data: claudeSessions, isLoading: sessionsLoading } =
    trpc.session.listClaudeSessions.useQuery(
      { workspaceId },
      {
        refetchInterval: 10_000, // Poll every 10s instead of 5s
        staleTime: 0, // Always refetch on invalidate - critical for session creation UX
        refetchOnWindowFocus: false,
      }
    );

  const { data: maxSessions } = trpc.session.getMaxSessionsPerWorkspace.useQuery();

  const firstSession = claudeSessions?.[0];
  // Database record ID for the first session
  const initialDbSessionId = firstSession?.id;

  return {
    workspace,
    workspaceLoading,
    claudeSessions,
    sessionsLoading,
    initialDbSessionId,
    maxSessions,
    invalidateWorkspace,
  };
}

// =============================================================================
// useSessionManagement - Handles session CRUD operations
// =============================================================================

interface UseSessionManagementOptions {
  workspaceId: string;
  slug: string;
  claudeSessions: ReturnType<typeof useWorkspaceData>['claudeSessions'];
  sendMessage: (text: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedDbSessionId: string | null;
  setSelectedDbSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  /** Selected model from chat settings */
  selectedModel: string;
  /** Whether the session is ready to receive messages (session_loaded received) */
  isSessionReady: boolean;
}

/** Minimal mutation interface exposing only the properties we use */
interface MutationLike<TInput, TOutput = unknown, TError = unknown> {
  mutate: (
    input: TInput,
    options?: { onSuccess?: (data: TOutput) => void; onError?: (error: TError) => void }
  ) => void;
  isPending: boolean;
}

interface AvailableIde {
  id: string;
  name: string;
}

/** Explicit return type to avoid TypeScript portability issues with internal tRPC types */
export interface UseSessionManagementReturn {
  createSession: MutationLike<
    { workspaceId: string; workflow: string; model: string; name: string },
    { id: string }
  >;
  deleteSession: MutationLike<{ id: string }>;
  archiveWorkspace: MutationLike<{ id: string; commitUncommitted?: boolean }>;
  openInIde: MutationLike<{ id: string }>;
  availableIdes: AvailableIde[];
  preferredIde: string;
  handleSelectSession: (dbSessionId: string) => void;
  handleCloseSession: (dbSessionId: string) => void;
  handleNewChat: () => void;
  handleQuickAction: (name: string, prompt: string) => void;
}

export function useSessionManagement({
  workspaceId,
  slug,
  claudeSessions,
  sendMessage,
  inputRef,
  selectedDbSessionId,
  setSelectedDbSessionId,
  selectedModel,
  isSessionReady,
}: UseSessionManagementOptions): UseSessionManagementReturn {
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Ref to store pending quick action prompt (to send after session is ready)
  const pendingQuickActionRef = useRef<{ dbSessionId: string; prompt: string } | null>(null);

  // Effect to send pending quick action prompt when session is ready
  // We track the previous isSessionReady value to detect the transition from false -> true
  const wasSessionReadyRef = useRef(isSessionReady);
  useEffect(() => {
    const pending = pendingQuickActionRef.current;
    const transitionedToReady = !wasSessionReadyRef.current && isSessionReady;

    // Send pending prompt when session transitions from not-ready to ready
    if (pending && pending.dbSessionId === selectedDbSessionId && transitionedToReady) {
      pendingQuickActionRef.current = null;
      sendMessage(pending.prompt);
    }

    wasSessionReadyRef.current = isSessionReady;
  }, [selectedDbSessionId, sendMessage, isSessionReady]);

  const createSession = trpc.session.createClaudeSession.useMutation({
    onSuccess: (_data) => {
      // Invalidate marks the data as stale, then immediately refetch
      // With staleTime: 0, invalidate will trigger an immediate refetch
      utils.session.listClaudeSessions.invalidate({ workspaceId });
    },
  });

  const deleteSession = trpc.session.deleteClaudeSession.useMutation({
    onMutate: async ({ id }) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await utils.session.listClaudeSessions.cancel({ workspaceId });

      // Snapshot previous value
      const previousSessions = utils.session.listClaudeSessions.getData({ workspaceId });

      // Optimistically remove the session from the list
      utils.session.listClaudeSessions.setData({ workspaceId }, (old) =>
        old?.filter((s) => s.id !== id)
      );

      return { previousSessions };
    },
    onError: (_err, _variables, context) => {
      // Roll back on error
      if (context?.previousSessions) {
        utils.session.listClaudeSessions.setData({ workspaceId }, context.previousSessions);
      }
    },
    onSettled: () => {
      utils.session.listClaudeSessions.invalidate({ workspaceId });
    },
  });

  const archiveWorkspace = trpc.workspace.archive.useMutation({
    onSuccess: () => {
      void navigate(`/projects/${slug}/workspaces`);
    },
  });

  const openInIde = trpc.workspace.openInIde.useMutation({
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const { data: availableIdesData } = trpc.workspace.getAvailableIdes.useQuery();
  const availableIdes = availableIdesData?.ides ?? [];
  const preferredIde = availableIdesData?.preferredIde ?? 'cursor';

  const handleSelectSession = useCallback(
    (dbSessionId: string) => {
      // Only update the selected session ID here.
      // The WebSocket connection is keyed by dbSessionId, so changing it will
      // automatically reconnect and load the correct session.
      setSelectedDbSessionId(dbSessionId);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [inputRef, setSelectedDbSessionId]
  );

  const handleCloseSession = useCallback(
    (dbSessionId: string) => {
      if (!claudeSessions || claudeSessions.length === 0) {
        return;
      }

      const sessionIndex = claudeSessions.findIndex((s) => s.id === dbSessionId);
      if (sessionIndex === -1) {
        return;
      }

      const isSelectedSession = dbSessionId === selectedDbSessionId;
      deleteSession.mutate({ id: dbSessionId });

      if (isSelectedSession && claudeSessions.length > 1) {
        // Select the next or previous session
        // The WebSocket will automatically reconnect and load the new session
        const nextSession = claudeSessions[sessionIndex + 1] ?? claudeSessions[sessionIndex - 1];
        setSelectedDbSessionId(nextSession?.id ?? null);
      } else if (claudeSessions.length === 1) {
        // No more sessions - clear selection
        setSelectedDbSessionId(null);
      }
    },
    [claudeSessions, selectedDbSessionId, deleteSession, setSelectedDbSessionId]
  );

  // Generate next available "Chat N" name based on existing sessions
  const getNextChatName = useCallback(() => {
    const existingNumbers = (claudeSessions ?? [])
      .map((s) => {
        const match = s.name?.match(/^Chat (\d+)$/);
        return match ? Number.parseInt(match[1] as string, 10) : 0;
      })
      .filter((n) => n > 0);
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    return `Chat ${nextNumber}`;
  }, [claudeSessions]);

  const handleNewChat = useCallback(() => {
    const name = getNextChatName();

    createSession.mutate(
      { workspaceId, workflow: 'followup', model: selectedModel || undefined, name },
      {
        onSuccess: (session) => {
          // Setting the new session ID triggers WebSocket reconnection automatically
          setSelectedDbSessionId(session.id);
          setTimeout(() => inputRef.current?.focus(), 0);
        },
      }
    );
  }, [
    createSession,
    workspaceId,
    getNextChatName,
    setSelectedDbSessionId,
    inputRef,
    selectedModel,
  ]);

  const handleQuickAction = useCallback(
    (name: string, prompt: string) => {
      createSession.mutate(
        { workspaceId, workflow: 'followup', name, model: selectedModel || undefined },
        {
          onSuccess: (session) => {
            // Store the pending prompt to be sent once the session state settles
            pendingQuickActionRef.current = { dbSessionId: session.id, prompt };
            // Setting the new session ID triggers WebSocket reconnection automatically
            setSelectedDbSessionId(session.id);
          },
        }
      );
    },
    [createSession, workspaceId, setSelectedDbSessionId, selectedModel]
  );

  return {
    createSession,
    deleteSession,
    archiveWorkspace,
    openInIde,
    availableIdes,
    preferredIde,
    handleSelectSession,
    handleCloseSession,
    handleNewChat,
    handleQuickAction,
  };
}
