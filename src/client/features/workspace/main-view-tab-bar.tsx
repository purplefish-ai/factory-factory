import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { GitDiffIcon } from '@phosphor-icons/react/dist/csr/GitDiff';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { useEffect, useState } from 'react';
import { AgentSessionStatus } from '@/client/components/agent-session-status';
import { SubagentIcon } from '@/client/components/subagent-icon';
import { NewSessionAccountAction } from '@/client/features/session-selection';
import { type SubagentSelection, useLiveSubagent } from '@/client/features/subagents';
import { getSessionDisplayName } from '@/client/lib/session-display-name';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TabButton } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { SessionStatus as DbSessionStatus } from '@/shared/core';
import { ChatActionsMenu } from './chat-actions-menu';
import { ClosedSessionsDropdown } from './closed-sessions-dropdown';
import { RatchetWrenchIcon } from './ratchet-wrench-icon';
import {
  describeSessionCloseRisk,
  getSessionCloseRisk,
  type SessionCloseRisk,
  type SessionQueuedMessageCount,
} from './session-close-guard';
import { isWorkspaceSessionLimitReached } from './session-limit';
import {
  deriveSessionTabRuntime,
  type WorkspaceSessionRuntimeSummary,
} from './session-tab-runtime';
import type { MainViewTab } from './workspace-panel-context';
import { useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Types
// =============================================================================

interface Session {
  id: string;
  name: string | null;
  workflow?: string | null;
  status: DbSessionStatus;
  provider?: 'CLAUDE' | 'CODEX';
}

// =============================================================================
// Helper Functions
// =============================================================================

function getTabIcon(type: MainViewTab['type']) {
  switch (type) {
    case 'chat':
    case 'file':
      return FileCodeIcon;
    case 'diff':
      return GitDiffIcon;
    case 'screenshot':
      return CameraIcon;
    case 'closed-session':
      return ArchiveIcon;
    case 'subagent':
      return RobotIcon;
  }
}

// =============================================================================
// Status Dot Component
// =============================================================================

interface StatusDotProps {
  sessionSummary?: WorkspaceSessionRuntimeSummary;
  isCIFix?: boolean;
  isAgent?: boolean;
  persistedStatus?: DbSessionStatus;
}

function StatusDot({ sessionSummary, isCIFix, isAgent, persistedStatus }: StatusDotProps) {
  const status = deriveSessionTabRuntime(sessionSummary, persistedStatus);
  const StatusIcon = status.icon;

  // CI fix sessions show wrench icon instead of dot
  if (isCIFix) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center justify-center">
            <RatchetWrenchIcon
              enabled
              animated={status.isRunning}
              className="h-3.5 w-3.5 rounded-[4px] shrink-0"
              iconClassName={cn(
                status.isRunning && 'animate-pulse text-brand',
                !status.isRunning && 'text-warning'
              )}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <div className="font-medium">CI Fix: {status.label}</div>
          <div className="text-muted-foreground">{status.description}</div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center justify-center">
          {isAgent ? (
            <AgentSessionStatus
              label={status.label}
              icon={StatusIcon}
              color={status.color}
              pulse={status.pulse}
              spin={status.spin}
            />
          ) : (
            <StatusIcon
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                status.color,
                status.pulse && 'animate-pulse',
                status.spin && 'animate-spin'
              )}
            />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <div className="font-medium">{status.label}</div>
        <div className="text-muted-foreground">{status.description}</div>
      </TooltipContent>
    </Tooltip>
  );
}

// =============================================================================
// Sub-Components
// =============================================================================

interface TabItemProps {
  tab: MainViewTab;
  isActive: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

function TabItem({ tab, isActive, onSelect, onClose }: TabItemProps) {
  const Icon = getTabIcon(tab.type);
  return (
    <TabButton
      icon={<Icon className="h-3.5 w-3.5 shrink-0" />}
      label={tab.label}
      isActive={isActive}
      onSelect={onSelect}
      onClose={onClose}
      truncate
    />
  );
}

interface SubagentTabItemProps {
  selection: SubagentSelection;
  label: string;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRefresh: (selection: SubagentSelection) => void;
}

function SubagentTabItem({
  selection,
  label,
  isActive,
  onSelect,
  onClose,
  onRefresh,
}: SubagentTabItemProps) {
  const { selection: current, iconIndex } = useLiveSubagent(selection);
  const { parentSessionId, parentSessionName, subagent } = current;

  useEffect(() => {
    if (subagent !== selection.subagent) {
      onRefresh({ parentSessionId, parentSessionName, subagent });
    }
  }, [parentSessionId, parentSessionName, subagent, onRefresh, selection.subagent]);

  return (
    <TabButton
      icon={
        <span
          role="img"
          aria-label={`${subagent.status} sub-agent`}
          className={cn(
            'inline-flex shrink-0',
            (subagent.status === 'starting' || subagent.status === 'running') &&
              'animate-pulse motion-reduce:animate-none'
          )}
        >
          <SubagentIcon index={iconIndex} className="h-3.5 w-3.5" />
        </span>
      }
      label={label}
      isActive={isActive}
      onSelect={onSelect}
      onClose={onClose}
      truncate
    />
  );
}

// =============================================================================
// Session Tab Item
// =============================================================================

interface SessionTabItemProps {
  label: string;
  isActive: boolean;
  sessionSummary?: WorkspaceSessionRuntimeSummary;
  isCIFix?: boolean;
  isAgent?: boolean;
  persistedStatus?: DbSessionStatus;
  onSelect: () => void;
  onClose?: () => void;
}

function SessionTabItem({
  label,
  isActive,
  sessionSummary,
  isCIFix,
  isAgent,
  persistedStatus,
  onSelect,
  onClose,
}: SessionTabItemProps) {
  return (
    <TabButton
      icon={
        <StatusDot
          sessionSummary={sessionSummary}
          isCIFix={isCIFix}
          isAgent={isAgent}
          persistedStatus={persistedStatus}
        />
      }
      label={label}
      isActive={isActive}
      onSelect={onSelect}
      onClose={onClose}
      truncate
    />
  );
}

// =============================================================================
// Main Component
// =============================================================================

interface MainViewTabBarProps {
  className?: string;
  workspaceId: string;
  sessions?: Session[];
  currentSessionId?: string | null;
  /** Queued (unsent) messages and their session; closing that session discards them. */
  queuedMessageCount?: SessionQueuedMessageCount | null;
  sessionSummariesById?: ReadonlyMap<string, WorkspaceSessionRuntimeSummary>;
  onSelectSession?: (sessionId: string) => void;
  onCreateSession?: (codexAccountId?: string) => void;
  onCloseSession?: (sessionId: string) => void;
  onSelectClosedSession?: (sessionId: string) => void;
  onRestartSession?: () => void;
  disabled?: boolean;
  /** Maximum sessions allowed per workspace */
  maxSessions?: number;
}

export function MainViewTabBar({
  className,
  workspaceId,
  sessions,
  currentSessionId,
  queuedMessageCount,
  sessionSummariesById,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  onSelectClosedSession,
  onRestartSession,
  disabled,
  maxSessions,
}: MainViewTabBarProps) {
  const { tabs, activeTabId, selectTab, closeTab, updateSubagentTab } = useWorkspacePanel();
  // The request outlives `closeConfirmOpen` so the dialog keeps its copy while
  // it animates closed.
  const [closeRequest, setCloseRequest] = useState<{
    sessionId: string;
    label: string;
    risk: SessionCloseRisk;
  } | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  const requestCloseSession = (session: Session, label: string) => {
    const risk = getSessionCloseRisk({
      summary: sessionSummariesById?.get(session.id),
      persistedStatus: session.status,
      queuedMessageCount:
        queuedMessageCount?.sessionId === session.id ? queuedMessageCount.count : 0,
    });
    if (!risk) {
      onCloseSession?.(session.id);
      return;
    }
    setCloseRequest({ sessionId: session.id, label, risk });
    setCloseConfirmOpen(true);
  };
  const closeRequestCopy = closeRequest
    ? describeSessionCloseRisk(closeRequest.label, closeRequest.risk)
    : null;

  // Filter out the default 'chat' tab since we're showing sessions instead
  const nonChatTabs = tabs.filter((tab) => tab.type !== 'chat');

  // Check if active session limit is reached
  const isAtLimit = isWorkspaceSessionLimitReached(sessions, maxSessions);
  // New sessions inherit the first session's provider/model, so wait for the list.
  const isButtonDisabled = disabled || isAtLimit || sessions === undefined;
  const currentSessionIndex =
    sessions?.findIndex((session) => session.id === currentSessionId) ?? -1;
  const currentSession = currentSessionIndex >= 0 ? sessions?.[currentSessionIndex] : undefined;
  const currentSessionLabel = currentSession
    ? getSessionDisplayName(currentSession, `Chat ${currentSessionIndex + 1}`)
    : null;

  return (
    <div className={cn('flex items-center bg-muted/50', className)}>
      {/* Scrollable tab area */}
      <div
        role="tablist"
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto p-1"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {/* Session tabs (Chat 1, Chat 2, etc.) */}
        {sessions?.map((session, index) => {
          const isSelected = session.id === currentSessionId;
          const baseLabel = getSessionDisplayName(session, `Chat ${index + 1}`);
          return (
            <SessionTabItem
              key={session.id}
              label={baseLabel}
              isActive={isSelected && activeTabId === 'chat'}
              sessionSummary={sessionSummariesById?.get(session.id)}
              isCIFix={session.workflow === 'ci-fix'}
              isAgent={session.workflow === 'periodic-task'}
              persistedStatus={session.status}
              onSelect={() => {
                onSelectSession?.(session.id);
                selectTab('chat');
              }}
              onClose={
                sessions.length > 1 ? () => requestCloseSession(session, baseLabel) : undefined
              }
            />
          );
        })}

        {onSelectClosedSession && (
          <div className="ml-0.5 shrink-0">
            <ClosedSessionsDropdown
              workspaceId={workspaceId}
              onSelectClosedSession={onSelectClosedSession}
              disabled={disabled}
            />
          </div>
        )}

        {/* Separator between sessions and file tabs */}
        {nonChatTabs.length > 0 && <div className="h-4 w-px bg-border mx-1" />}

        {/* File/diff tabs */}
        {nonChatTabs.map((tab) =>
          tab.type === 'subagent' && tab.subagentSelection ? (
            <SubagentTabItem
              key={tab.id}
              selection={tab.subagentSelection}
              label={tab.label}
              isActive={tab.id === activeTabId}
              onSelect={() => selectTab(tab.id)}
              onClose={() => closeTab(tab.id)}
              onRefresh={updateSubagentTab}
            />
          ) : (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={() => selectTab(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
          )
        )}
      </div>

      {/* New session button: inherits the workspace's provider and model */}
      {onCreateSession && (
        <div className="mx-1 flex shrink-0 items-center py-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <NewSessionAccountAction
                  provider={sessions?.[0]?.provider}
                  onCreate={onCreateSession}
                  disabled={isButtonDisabled}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {isAtLimit ? `Maximum ${maxSessions} sessions per workspace` : 'New session'}
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Chat actions (Restart) — pinned to the right, outside the scrollable area */}
      {onRestartSession && (
        <div className="shrink-0 pr-1">
          <ChatActionsMenu
            chatLabel={currentSessionLabel}
            onRestartSession={onRestartSession}
            disabled={disabled}
          />
        </div>
      )}

      <ConfirmDialog
        open={closeConfirmOpen}
        onOpenChange={setCloseConfirmOpen}
        title={closeRequestCopy?.title ?? ''}
        description={closeRequestCopy?.description ?? ''}
        confirmText={closeRequestCopy?.confirmText}
        variant="destructive"
        onConfirm={() => {
          setCloseConfirmOpen(false);
          if (closeRequest) {
            onCloseSession?.(closeRequest.sessionId);
          }
        }}
      />
    </div>
  );
}
