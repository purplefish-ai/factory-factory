import type { inferRouterOutputs } from '@trpc/server';
import type { ReactNode } from 'react';

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
  runningSessionId: string | undefined;
  isCreatingSession: boolean;
  isDeletingSession: boolean;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onCloseSession: (sessionId: string) => void;
  children: ReactNode;
  /** Maximum sessions allowed per workspace */
  maxSessions?: number;
}

// =============================================================================
// Component
// =============================================================================

/**
 * WorkspaceContentView handles the rendering of:
 * - Loading state (when no sessions exist yet - auto-creation in progress)
 * - Session tab bar + chat content (when sessions exist)
 */
export function WorkspaceContentView({
  workspaceId,
  claudeSessions,
  selectedSessionId,
  runningSessionId,
  isCreatingSession,
  isDeletingSession,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  children,
  maxSessions,
}: WorkspaceContentViewProps) {
  // Show loading state when no sessions exist (auto-creation should be in progress)
  if (!claudeSessions || claudeSessions.length === 0) {
    return (
      <MainViewContent workspaceId={workspaceId} className="flex-1">
        <div className="flex items-center justify-center h-full">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </MainViewContent>
    );
  }

  // Show tab bar + chat content when sessions exist
  // Wrap in a flex container with min-h-0 to enable proper overflow handling
  // Without this, the ScrollArea in ChatContent cannot calculate its height correctly
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar - flex-shrink-0 ensures it stays visible */}
      <div className="border-b flex-shrink-0">
        <MainViewTabBar
          sessions={claudeSessions}
          currentSessionId={selectedSessionId}
          runningSessionId={runningSessionId}
          onSelectSession={onSelectSession}
          onCreateSession={onCreateSession}
          onCloseSession={onCloseSession}
          disabled={isCreatingSession || isDeletingSession}
          maxSessions={maxSessions}
        />
      </div>

      {/* Main View Content (children = ChatContent) */}
      <MainViewContent workspaceId={workspaceId} className="flex-1 min-h-0">
        {children}
      </MainViewContent>
    </div>
  );
}
