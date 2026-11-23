import { useMemo } from 'react';
import { EmptyState } from '@/client/components/empty-state';
import { Loading } from '@/client/components/loading';
import { QueryErrorState, QueryRefreshError } from '@/client/components/query-error-state';
import { type SessionData, SessionTabBar } from '@/client/features/chat';
import { getNewChatUnavailableReason } from '@/client/features/workspace';
import { trpc } from '@/client/lib/trpc';
import { useUserSettings } from '@/client/lib/user-settings-queries';
import { Button } from '@/components/ui/button';
import { useKanbanState } from './kanban-context';
import { QuickChatContent } from './quick-chat-content';
import { useQuickChat } from './use-quick-chat';
import type { QuickChatScrollMemory } from './use-quick-chat-scroll';

interface QuickChatSheetBodyProps {
  workspaceId: string | null;
  /** Owned by the sheet, which outlives this body, so positions survive closing it. */
  scrollMemory?: QuickChatScrollMemory;
}

function QuickChatSessionState({
  sessionsLoaded,
  hasSessions,
  creating,
  disabled,
  disabledReason,
  onCreate,
  error,
  retrying,
  onRetry,
}: {
  sessionsLoaded: boolean;
  hasSessions: boolean;
  creating: boolean;
  disabled: boolean;
  disabledReason?: string | null;
  onCreate: () => void;
  error?: { message: string } | null;
  retrying?: boolean;
  onRetry: () => void;
}) {
  if (!sessionsLoaded && error) {
    return (
      <QueryErrorState
        title="Couldn't load chats"
        error={error}
        onRetry={onRetry}
        isRetrying={retrying}
      />
    );
  }
  if (!sessionsLoaded || creating || hasSessions) {
    return <Loading size="compact" message={creating ? 'Creating chat…' : 'Loading sessions…'} />;
  }
  return (
    <EmptyState
      size="compact"
      title="No chats yet"
      description={disabledReason}
      action={
        <Button variant="outline" size="sm" onClick={onCreate} disabled={disabled}>
          New chat
        </Button>
      }
    />
  );
}

function QuickChatLimitError({
  query,
}: {
  query: {
    data?: number;
    error: { message: string } | null;
    isFetching: boolean;
    refetch: () => unknown;
  };
}) {
  if (!query.error) {
    return null;
  }
  // A cached limit still applies, so a failed refetch only adds a notice.
  if (query.data !== undefined) {
    return (
      <QueryRefreshError
        title="Couldn't refresh the chat limit"
        error={query.error}
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    );
  }
  return (
    <QueryErrorState
      title="Couldn't load the chat limit"
      error={query.error}
      onRetry={() => void query.refetch()}
      isRetrying={query.isFetching}
      className="shrink-0 border-b p-3"
    />
  );
}

/** A cached limit still applies when only a refetch failed. */
function getChatLimitUnavailableReason(query: {
  data?: number;
  error: { message: string } | null;
}): string | null {
  if (query.data !== undefined) {
    return null;
  }
  return query.error ? "Couldn't load the chat limit." : 'Loading chat limit…';
}

/**
 * Quick Chat's tabs and transcript. `lazy-quick-chat-sheet.tsx` loads it inside the
 * open sheet, so it unmounts whenever the sheet closes.
 */
export function QuickChatSheetBody({ workspaceId, scrollMemory }: QuickChatSheetBodyProps) {
  const { workspaces } = useKanbanState();
  const workspace = useMemo(
    () => workspaces?.find((w) => w.id === workspaceId) ?? null,
    [workspaces, workspaceId]
  );

  const explicitWorkspaceProvider =
    workspace?.defaultSessionProvider === 'CODEX' || workspace?.defaultSessionProvider === 'CLAUDE'
      ? workspace.defaultSessionProvider
      : undefined;
  const settings = useUserSettings({
    enabled: !!workspaceId && !explicitWorkspaceProvider,
    staleTime: 30_000,
  });
  const maxSessionsQuery = trpc.session.getMaxSessionsPerWorkspace.useQuery(undefined, {
    enabled: !!workspaceId,
  });
  const workspaceProvider = explicitWorkspaceProvider ?? settings.data?.defaultSessionProvider;

  const {
    sessions,
    selectedSessionId,
    selectedCodexAccountId,
    setSelectedSessionId,
    chatState,
    transcriptScroll,
    handleNewChat,
    handleCloseSession,
    handleQuickAction,
    isCreatingSession,
    isDeletingSession,
    sessionsLoaded,
    sessionsError,
    refetchSessions,
    isFetchingSessions,
  } = useQuickChat(workspaceId, workspaceProvider, scrollMemory);

  const sessionTabData: SessionData[] = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.id,
        status: s.status,
        name: s.name ?? null,
        workflow: s.workflow,
        provider: s.provider,
        createdAt: new Date(s.createdAt),
      })),
    [sessions]
  );

  const runningSessionId = useMemo(() => sessions.find((s) => s.isWorking)?.id ?? null, [sessions]);

  // There are no tabs until sessions load, and new chats need the list for their defaults.
  const tabBarDisabled = isCreatingSession || !workspaceId || !sessionsLoaded;
  const maxSessions = maxSessionsQuery.data;
  const newChatUnavailableReason =
    getChatLimitUnavailableReason(maxSessionsQuery) ??
    getNewChatUnavailableReason({
      sessions: sessionsLoaded && maxSessions !== undefined ? sessions : undefined,
      maxSessions,
      hasWorktreePath: Boolean(workspace?.worktreePath),
      isCreatingSession,
      isDeletingSession,
    });

  return (
    <>
      {/* Session tab bar with actions — always visible */}
      <div className="flex items-center gap-1 px-4 py-2 border-b shrink-0">
        <div className="flex-1 min-w-0">
          <SessionTabBar
            sessions={sessionTabData}
            workspaceProvider={workspaceProvider}
            currentSessionId={selectedSessionId}
            runningSessionId={runningSessionId}
            onSelectSession={setSelectedSessionId}
            onCreateSession={handleNewChat}
            onCloseSession={handleCloseSession}
            disabled={tabBarDisabled}
            createDisabled={Boolean(newChatUnavailableReason)}
            createPending={isCreatingSession}
          />
        </div>
      </div>

      <QuickChatLimitError query={maxSessionsQuery} />

      {/* Chat content */}
      <div className="flex-1 min-h-0">
        {workspaceId && selectedSessionId ? (
          <QuickChatContent
            workspaceId={workspaceId}
            codexAccountId={selectedCodexAccountId}
            chatState={chatState}
            transcriptScroll={transcriptScroll}
            onRunQuickActionInNewChat={handleQuickAction}
            newChatUnavailableReason={newChatUnavailableReason}
          />
        ) : workspaceId ? (
          <QuickChatSessionState
            sessionsLoaded={sessionsLoaded}
            hasSessions={sessions.length > 0}
            creating={isCreatingSession}
            disabled={tabBarDisabled || Boolean(newChatUnavailableReason)}
            disabledReason={newChatUnavailableReason}
            onCreate={() => handleNewChat()}
            error={sessionsError}
            retrying={isFetchingSessions}
            onRetry={() => {
              void refetchSessions();
            }}
          />
        ) : null}
      </div>
    </>
  );
}
