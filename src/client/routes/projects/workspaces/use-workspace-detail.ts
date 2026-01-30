import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { trpc } from '@/frontend/lib/trpc';

// =============================================================================
// useWorkspaceData - Fetches workspace and session data
// =============================================================================

interface UseWorkspaceDataOptions {
  workspaceId: string;
}

export function useWorkspaceData({ workspaceId }: UseWorkspaceDataOptions) {
  // Increased staleTime to reduce unnecessary re-renders from background fetches
  const { data: workspace, isLoading: workspaceLoading } = trpc.workspace.get.useQuery(
    { id: workspaceId },
    {
      refetchInterval: 30_000, // Poll every 30s for background updates (worktreePath set on creation)
      staleTime: 10_000, // Data considered fresh for 10s
      refetchOnWindowFocus: false, // Don't refetch on tab focus
    }
  );

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

  const { data: workflows } = trpc.session.listWorkflows.useQuery(undefined, {
    enabled: claudeSessions !== undefined && claudeSessions.length === 0,
  });

  const { data: recommendedWorkflow } = trpc.session.getRecommendedWorkflow.useQuery(
    { workspaceId },
    { enabled: claudeSessions !== undefined && claudeSessions.length === 0 }
  );

  const firstSession = claudeSessions?.[0];
  // Database record ID for the first session
  const initialDbSessionId = firstSession?.id;

  return {
    workspace,
    workspaceLoading,
    claudeSessions,
    sessionsLoading,
    workflows,
    recommendedWorkflow,
    initialDbSessionId,
    maxSessions,
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
}

/** Minimal mutation interface exposing only the properties we use */
interface MutationLike<TInput, TOutput = unknown> {
  mutate: (input: TInput, options?: { onSuccess?: (data: TOutput) => void }) => void;
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
  archiveWorkspace: MutationLike<{ id: string }>;
  openInIde: MutationLike<{ id: string }>;
  availableIdes: AvailableIde[];
  preferredIde: string;
  handleSelectSession: (dbSessionId: string) => void;
  handleCloseSession: (dbSessionId: string) => void;
  handleWorkflowSelect: (workflowId: string) => void;
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
}: UseSessionManagementOptions): UseSessionManagementReturn {
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Ref to store pending quick action prompt (to send after session is ready)
  const pendingQuickActionRef = useRef<{ dbSessionId: string; prompt: string } | null>(null);

  // Effect to send pending quick action prompt when session is selected
  useEffect(() => {
    const pending = pendingQuickActionRef.current;
    if (pending && pending.dbSessionId === selectedDbSessionId) {
      pendingQuickActionRef.current = null;
      sendMessage(pending.prompt);
    }
  }, [selectedDbSessionId, sendMessage]);

  const createSession = trpc.session.createClaudeSession.useMutation({
    onSuccess: (_data) => {
      // Invalidate marks the data as stale, then immediately refetch
      // With staleTime: 0, invalidate will trigger an immediate refetch
      utils.session.listClaudeSessions.invalidate({ workspaceId });
    },
  });

  const deleteSession = trpc.session.deleteClaudeSession.useMutation({
    onSuccess: () => {
      utils.session.listClaudeSessions.invalidate({ workspaceId });
    },
  });

  const archiveWorkspace = trpc.workspace.archive.useMutation({
    onSuccess: () => {
      navigate(`/projects/${slug}/workspaces`);
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
        return match ? Number.parseInt(match[1], 10) : 0;
      })
      .filter((n) => n > 0);
    const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
    return `Chat ${nextNumber}`;
  }, [claudeSessions]);

  const handleWorkflowSelect = useCallback(
    (workflowId: string) => {
      const chatName = getNextChatName();
      createSession.mutate(
        { workspaceId, workflow: workflowId, model: 'sonnet', name: chatName },
        {
          onSuccess: (session) => {
            // Setting the new session ID triggers WebSocket reconnection automatically
            setSelectedDbSessionId(session.id);
          },
        }
      );
    },
    [createSession, workspaceId, getNextChatName, setSelectedDbSessionId]
  );

  const handleNewChat = useCallback(() => {
    const name = getNextChatName();

    createSession.mutate(
      { workspaceId, workflow: 'followup', model: 'sonnet', name },
      {
        onSuccess: (session) => {
          // Setting the new session ID triggers WebSocket reconnection automatically
          setSelectedDbSessionId(session.id);
        },
      }
    );
  }, [createSession, workspaceId, getNextChatName, setSelectedDbSessionId]);

  const handleQuickAction = useCallback(
    (name: string, prompt: string) => {
      createSession.mutate(
        { workspaceId, workflow: 'followup', name, model: 'sonnet' },
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
    [createSession, workspaceId, setSelectedDbSessionId]
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
    handleWorkflowSelect,
    handleNewChat,
    handleQuickAction,
  };
}

// =============================================================================
// useAutoScroll - Manages auto-scroll behavior with RAF throttling
// =============================================================================

/**
 * Hook for managing auto-scroll behavior with RAF throttling.
 * Optimized for virtualized lists - doesn't require contentRef.
 */
export function useAutoScroll(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  inputRef: React.RefObject<HTMLTextAreaElement | null>
) {
  const [isNearBottom, setIsNearBottom] = useState(true);
  const isNearBottomRef = useRef(true);
  // Track if we're currently animating a scroll-to-bottom to prevent flicker
  const isScrollingToBottomRef = useRef(false);
  // RAF throttle flag
  const rafPendingRef = useRef(false);

  // Throttled scroll handler using requestAnimationFrame
  const onScroll = useCallback(() => {
    // Don't update state while animating scroll-to-bottom (prevents flicker)
    if (isScrollingToBottomRef.current) {
      return;
    }

    // Skip if we already have a pending RAF
    if (rafPendingRef.current) {
      return;
    }

    rafPendingRef.current = true;
    requestAnimationFrame(() => {
      rafPendingRef.current = false;

      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }

      // Increased threshold for better UX - don't hide scroll button too early
      const scrollThreshold = 150;
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const nearBottom = distanceFromBottom < scrollThreshold;

      // Only update state if it changed
      if (nearBottom !== isNearBottomRef.current) {
        isNearBottomRef.current = nearBottom;
        setIsNearBottom(nearBottom);
      }
    });
  }, [viewportRef]);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    // Set flag to prevent onScroll from causing flicker during animation
    isScrollingToBottomRef.current = true;
    setIsNearBottom(true);
    isNearBottomRef.current = true;

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: 'smooth',
    });

    // Focus the input for convenience
    inputRef.current?.focus();

    // Clear the flag after animation completes (smooth scroll typically ~300-500ms)
    setTimeout(() => {
      isScrollingToBottomRef.current = false;
    }, 500);
  }, [viewportRef, inputRef]);

  return { onScroll, isNearBottom, scrollToBottom };
}
