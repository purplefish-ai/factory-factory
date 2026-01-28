'use client';

import type { inferRouterOutputs } from '@trpc/server';
import type { ReactNode } from 'react';

import type { AppRouter } from '@/frontend/lib/trpc';

import { MainViewContent } from './main-view-content';
import { MainViewTabBar } from './main-view-tab-bar';
import { WorkflowSelector } from './workflow-selector';

// =============================================================================
// Types
// =============================================================================

type RouterOutputs = inferRouterOutputs<AppRouter>;
type ClaudeSession = RouterOutputs['session']['listClaudeSessions'][number];
type Workflow = RouterOutputs['session']['listWorkflows'][number];

interface WorkspaceContentViewProps {
  workspaceId: string;
  claudeSessions: ClaudeSession[] | undefined;
  workflows: Workflow[] | undefined;
  recommendedWorkflow: string | undefined;
  selectedSessionId: string | null;
  runningSessionId: string | undefined;
  running: boolean;
  isCreatingSession: boolean;
  isDeletingSession: boolean;
  onWorkflowSelect: (workflowId: string) => void;
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
 * WorkspaceContentView handles the conditional rendering between:
 * - Workflow selector (when no sessions exist yet)
 * - Session tab bar + chat content (when sessions exist)
 *
 * This extraction reduces cognitive complexity in the main page component.
 */
export function WorkspaceContentView({
  workspaceId,
  claudeSessions,
  workflows,
  recommendedWorkflow,
  selectedSessionId,
  runningSessionId,
  running,
  isCreatingSession,
  isDeletingSession,
  onWorkflowSelect,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  children,
  maxSessions,
}: WorkspaceContentViewProps) {
  // Show workflow selector when no sessions exist
  if (claudeSessions && claudeSessions.length === 0) {
    return (
      <MainViewContent workspaceId={workspaceId} className="flex-1">
        {workflows && recommendedWorkflow ? (
          <WorkflowSelector
            workflows={workflows}
            recommendedWorkflow={recommendedWorkflow}
            onSelect={onWorkflowSelect}
            disabled={isCreatingSession}
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
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
          disabled={running || isCreatingSession || isDeletingSession}
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
