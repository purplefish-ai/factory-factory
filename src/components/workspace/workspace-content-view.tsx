import type { inferRouterOutputs } from '@trpc/server';
import type { ReactNode } from 'react';
import type { ProcessStatus, SessionStatus } from '@/components/chat/reducer';
import type { AppRouter } from '@/frontend/lib/trpc';

import { MainViewContent } from './main-view-content';
import { MainViewTabBar } from './main-view-tab-bar';

// =============================================================================
// Types
// =============================================================================

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ClaudeSession = RouterOutputs['session']['listClaudeSessions'][number];

interface WorkspaceContentViewProps {
  workspaceId: string;
  claudeSessions: ClaudeSession[] | undefined;
  selectedSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  /** Session status for the currently selected session */
  sessionStatus?: SessionStatus;
  /** Process status for the currently selected session */
  processStatus?: ProcessStatus;
  isCreatingSession: boolean;
  isDeletingSession: boolean;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onCloseSession: (sessionId: string) => void;
  children: ReactNode;
  /** Maximum sessions allowed per workspace */
  maxSessions?: number;
  /** Whether the workspace has a worktree path (required for sessions) */
  hasWorktreePath: boolean;
}

// =============================================================================
// Component
// =============================================================================

/**
 * WorkspaceContentView handles the conditional rendering between:
 * - Empty state prompt (when no sessions exist yet)
 * - Session tab bar + chat content (when sessions exist)
 *
 * This extraction reduces cognitive complexity in the main page component.
 */
export function WorkspaceContentView({
  workspaceId,
  claudeSessions,
  selectedSessionId,
  runningSessionIds,
  sessionStatus,
  processStatus,
  isCreatingSession,
  isDeletingSession,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  children,
  maxSessions,
  hasWorktreePath,
}: WorkspaceContentViewProps) {
  const hasNoSessions = claudeSessions && claudeSessions.length === 0;

  // Always show tab bar (with "+" button), but render empty state content when no sessions exist
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar - flex-shrink-0 ensures it stays visible */}
      <div className="border-b flex-shrink-0">
        <MainViewTabBar
          sessions={claudeSessions}
          currentSessionId={selectedSessionId}
          runningSessionIds={runningSessionIds}
          sessionStatus={sessionStatus}
          processStatus={processStatus}
          onSelectSession={onSelectSession}
          onCreateSession={onCreateSession}
          onCloseSession={onCloseSession}
          disabled={isCreatingSession || isDeletingSession || !hasWorktreePath}
          maxSessions={maxSessions}
        />
      </div>

      {/* Main View Content */}
      <MainViewContent workspaceId={workspaceId} className="flex-1 min-h-0">
        {hasNoSessions ? (
          <div className="flex flex-col items-center justify-center h-full p-8">
            <div className="max-w-md w-full space-y-6 text-center">
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold">Start a Session</h2>
                <p className="text-muted-foreground">
                  Click the + button above to start a new chat session in this workspace.
                </p>
              </div>

              {!hasWorktreePath && (
                <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded-md text-sm">
                  Workspace is initializing... Please wait for the worktree to be created.
                </div>
              )}
            </div>
          </div>
        ) : (
          children
        )}
      </MainViewContent>
    </div>
  );
}
