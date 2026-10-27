import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useSessionCollectionCommands } from '@/client/features/chat';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { isArchiveGitIndexLockedError } from '@/client/lib/workspace-archive';
import {
  removeWorkspaceFromProjectWorkspaceCache,
  restoreWorkspacesToProjectWorkspaceCache,
} from '@/client/lib/workspace-cache-helpers';
import type { SessionProviderValue } from '@/lib/session-provider-selection';

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
      // Workspace state is live-synced via /snapshots (useProjectSnapshotSync).
      // Keep tRPC query as bootstrap/fallback, not a periodic poller.
      staleTime: Number.POSITIVE_INFINITY,
      refetchOnWindowFocus: false, // Don't refetch on tab focus
    }
  );

  // Expose invalidate function for external triggers (e.g., when session stops running)
  const invalidateWorkspace = useCallback(() => {
    runInBackground(utils.workspace.get.invalidate({ id: workspaceId }), 'Could not refresh data');
  }, [utils, workspaceId]);

  // Sync PR status from GitHub on page load (if workspace has a PR)
  const syncPRStatus = trpc.workspace.syncPRStatus.useMutation({
    onSuccess: () => {
      // Refresh workspace data after PR sync
      runInBackground(
        utils.workspace.get.invalidate({ id: workspaceId }),
        'Could not refresh data'
      );
    },
  });

  // Sync PR status once when workspace loads with a PR URL
  const hasSyncedRef = useRef(false);
  useEffect(() => {
    if (workspace?.prs.length && !hasSyncedRef.current && !syncPRStatus.isPending) {
      hasSyncedRef.current = true;
      syncPRStatus.mutate({ workspaceId });
    }
  }, [workspace?.prs.length, workspaceId, syncPRStatus]);

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
  onArchiveGitIndexLocked: () => void;
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
    {
      workspaceId: string;
      workflow: string;
      model?: string;
      name: string;
      provider?: SessionProviderValue;
      initialMessage?: string;
      initialPrompt?: string;
    },
    { id: string }
  >;
  deleteSession: MutationLike<{ id: string }>;
  archiveWorkspace: MutationLike<{ id: string; removeGitIndexLock?: true }>;
  openInIde: MutationLike<{ id: string }>;
  availableIdes: AvailableIde[];
  preferredIde: string;
  handleSelectSession: (dbSessionId: string) => void;
  handleCloseSession: (dbSessionId: string) => void;
  handleNewChat: () => void;
  handleQuickAction: (name: string, prompt: string) => Promise<void>;
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
  onArchiveGitIndexLocked,
}: UseSessionManagementOptions): UseSessionManagementReturn {
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const activeWorkspaceRef = useRef(workspaceId);
  useLayoutEffect(() => {
    activeWorkspaceRef.current = workspaceId;
  }, [workspaceId]);
  const {
    createSession,
    deleteSession,
    createChat: handleNewChat,
    createQuickActionAsync: handleQuickAction,
  } = useSessionCollectionCommands({
    workspaceId,
    sessions,
    // Codex uses its own model defaults instead of the Claude model selection.
    creationDefaults: {
      provider: selectedProvider,
      model: selectedProvider === 'CODEX' ? undefined : selectedModel || undefined,
    },
    onCreated: (session, originatingWorkspaceId, kind) => {
      if (activeWorkspaceRef.current !== originatingWorkspaceId) {
        return;
      }
      setSelectedDbSessionId(session.id);
      if (kind === 'chat') {
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    },
  });

  const archiveWorkspace = trpc.workspace.archive.useMutation({
    onMutate: async ({ id }) => {
      const workspace = utils.workspace.get.getData({ id });
      const projectId = workspace?.projectId;

      if (!projectId) {
        return { projectId, previousWorkspaces: undefined };
      }

      await utils.workspace.listForProject.cancel({ projectId });
      const previousWorkspaces = utils.workspace.listForProject.getData({ projectId });

      utils.workspace.listForProject.setData({ projectId }, (old) =>
        removeWorkspaceFromProjectWorkspaceCache(old, id)
      );

      return { projectId, previousWorkspaces };
    },
    onSuccess: () => {
      if (slug) {
        void navigate(`/projects/${slug}/workspaces`, { replace: true });
      } else {
        void navigate('/projects', { replace: true });
      }
    },
    onError: (error, _variables, context) => {
      if (context?.projectId && context.previousWorkspaces) {
        utils.workspace.listForProject.setData({ projectId: context.projectId }, (old) =>
          restoreWorkspacesToProjectWorkspaceCache(old, context.previousWorkspaces, [_variables.id])
        );
      }

      if (isArchiveGitIndexLockedError(error)) {
        onArchiveGitIndexLocked();
      } else {
        toast.error(error.message || 'Failed to archive workspace');
      }
    },
    onSettled: (_data, _error, variables, context) => {
      void utils.workspace.get.invalidate({ id: variables.id });
      if (context?.projectId) {
        void utils.workspace.listForProject.invalidate({ projectId: context.projectId });
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
