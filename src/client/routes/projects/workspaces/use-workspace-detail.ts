import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { trpc } from '@/frontend/lib/trpc';
import {
  type NewSessionProviderSelection,
  resolveExplicitSessionProvider,
  type SessionProviderValue,
} from '@/lib/session-provider-selection';

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

  const { data: sessions, isLoading: sessionsLoading } = trpc.session.listSessions.useQuery(
    { workspaceId },
    {
      refetchInterval: 10_000, // Poll every 10s instead of 5s
      staleTime: 0, // Always refetch on invalidate - critical for session creation UX
      refetchOnWindowFocus: false,
    }
  );

  const { data: maxSessions } = trpc.session.getMaxSessionsPerWorkspace.useQuery();

  const firstSession = sessions?.[0];
  // Database record ID for the first session
  const initialDbSessionId = firstSession?.id;

  return {
    workspace,
    workspaceLoading,
    sessions,
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
  sessions: ReturnType<typeof useWorkspaceData>['sessions'];
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  selectedDbSessionId: string | null;
  setSelectedDbSessionId: (id: string | null) => void;
  /** Selected model from chat settings */
  selectedModel: string;
  /** Provider selection for newly created sessions */
  selectedProvider: SessionProviderValue;
}

export type { NewSessionProviderSelection };
export { resolveExplicitSessionProvider };

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
    {
      workspaceId: string;
      workflow: string;
      model: string;
      name: string;
      provider?: SessionProviderValue;
      initialMessage?: string;
    },
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
  sessions,
  inputRef,
  selectedDbSessionId,
  setSelectedDbSessionId,
  selectedModel,
  selectedProvider,
}: UseSessionManagementOptions): UseSessionManagementReturn {
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const createSession = trpc.session.createSession.useMutation({
    onSuccess: (_data) => {
      // Invalidate marks the data as stale, then immediately refetch
      // With staleTime: 0, invalidate will trigger an immediate refetch
      utils.session.listSessions.invalidate({ workspaceId });
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to create session');
    },
  });
  const startSession = trpc.session.startSession.useMutation();

  const deleteSession = trpc.session.deleteSession.useMutation({
    onMutate: async ({ id }) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await utils.session.listSessions.cancel({ workspaceId });

      // Snapshot previous value
      const previousSessions = utils.session.listSessions.getData({ workspaceId });

      // Optimistically remove the session from the list
      utils.session.listSessions.setData({ workspaceId }, (old) => old?.filter((s) => s.id !== id));

      return { previousSessions };
    },
    onError: (_err, _variables, context) => {
      // Roll back on error
      if (context?.previousSessions) {
        utils.session.listSessions.setData({ workspaceId }, context.previousSessions);
      }
    },
    onSettled: () => {
      utils.session.listSessions.invalidate({ workspaceId });
    },
  });

  const archiveWorkspace = trpc.workspace.archive.useMutation({
    onMutate: async ({ id }) => {
      const workspace = utils.workspace.get.getData({ id });
      const projectId = workspace?.projectId;

      if (projectId) {
        await utils.workspace.listWithKanbanState.cancel({ projectId });
      }

      const previousWorkspaceList = projectId
        ? utils.workspace.listWithKanbanState.getData({ projectId })
        : undefined;

      if (projectId) {
        utils.workspace.listWithKanbanState.setData({ projectId }, (old) =>
          old?.filter((workspaceItem) => workspaceItem.id !== id)
        );
      }

      return { projectId, previousWorkspaceList };
    },
    onSuccess: () => {
      if (slug) {
        void navigate(`/projects/${slug}/workspaces`);
      } else {
        void navigate('/projects');
      }
    },
    onError: (error, _variables, context) => {
      if (error.data?.code === 'PRECONDITION_FAILED') {
        toast.error('Archiving blocked: enable commit before archiving to proceed.');
      } else {
        toast.error(error.message || 'Failed to archive workspace');
      }

      if (context?.projectId) {
        if (context.previousWorkspaceList) {
          utils.workspace.listWithKanbanState.setData(
            { projectId: context.projectId },
            context.previousWorkspaceList
          );
        }
      }
    },
    onSettled: (_data, _error, variables, context) => {
      void utils.workspace.get.invalidate({ id: variables.id });
      if (context?.projectId) {
        void utils.workspace.listWithKanbanState.invalidate({ projectId: context.projectId });
        void utils.workspace.getProjectSummaryState.invalidate({ projectId: context.projectId });
      }
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
      if (!sessions || sessions.length === 0) {
        return;
      }

      const sessionIndex = sessions.findIndex((s) => s.id === dbSessionId);
      if (sessionIndex === -1) {
        return;
      }

      const isSelectedSession = dbSessionId === selectedDbSessionId;
      deleteSession.mutate({ id: dbSessionId });

      if (isSelectedSession && sessions.length > 1) {
        // Select the next or previous session
        // The WebSocket will automatically reconnect and load the new session
        const nextSession = sessions[sessionIndex + 1] ?? sessions[sessionIndex - 1];
        setSelectedDbSessionId(nextSession?.id ?? null);
      } else if (sessions.length === 1) {
        // No more sessions - clear selection
        setSelectedDbSessionId(null);
      }
    },
    [sessions, selectedDbSessionId, deleteSession, setSelectedDbSessionId]
  );

  // Generate next available "Chat N" name based on existing sessions
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
    const name = getNextChatName();
    const provider = selectedProvider;
    // Only pass the Claude model selection for Claude sessions; Codex uses its own model defaults.
    const model = provider === 'CODEX' ? undefined : selectedModel || undefined;

    createSession.mutate(
      {
        workspaceId,
        workflow: 'followup',
        model,
        name,
        provider,
      },
      {
        onSuccess: (session) => {
          const previousSessionId = selectedDbSessionId;
          startSession.mutate(
            { id: session.id, initialPrompt: '' },
            {
              onSuccess: () => {
                // Setting the new session ID triggers WebSocket reconnection automatically
                setSelectedDbSessionId(session.id);
                setTimeout(() => inputRef.current?.focus(), 0);
              },
              onError: (error) => {
                toast.error(error.message || 'Failed to start session');
                setSelectedDbSessionId(previousSessionId);
              },
            }
          );
        },
      }
    );
  }, [
    createSession,
    workspaceId,
    getNextChatName,
    startSession,
    selectedDbSessionId,
    setSelectedDbSessionId,
    inputRef,
    selectedModel,
    selectedProvider,
  ]);

  const handleQuickAction = useCallback(
    (name: string, prompt: string) => {
      const provider = selectedProvider;
      const model = provider === 'CODEX' ? undefined : selectedModel || undefined;
      const previousSessionId = selectedDbSessionId;
      createSession.mutate(
        { workspaceId, workflow: 'followup', name, model, provider, initialMessage: prompt },
        {
          onSuccess: (session) => {
            startSession.mutate(
              { id: session.id, initialPrompt: '' },
              {
                onSuccess: () => {
                  // Setting the new session ID triggers WebSocket reconnection automatically
                  setSelectedDbSessionId(session.id);
                },
                onError: (error) => {
                  toast.error(error.message || 'Failed to start session');
                  setSelectedDbSessionId(previousSessionId);
                },
              }
            );
          },
        }
      );
    },
    [
      createSession,
      workspaceId,
      startSession,
      selectedDbSessionId,
      setSelectedDbSessionId,
      selectedModel,
      selectedProvider,
    ]
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
