import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { GitDiffIcon } from '@phosphor-icons/react/dist/csr/GitDiff';
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot';
import { useEffect, useState } from 'react';
import { SessionStatusIcon } from '@/client/components/session-status-icon';
import { SubagentIcon } from '@/client/components/subagent-icon';
import { NewSessionAccountAction } from '@/client/features/session-selection';
import { useShortcut } from '@/client/features/shortcuts';
import { type SubagentSelection, useLiveSubagent } from '@/client/features/subagents';
import { useTablistFocus } from '@/client/hooks/use-tablist-focus';
import { getSessionDisplayName } from '@/client/lib/session-display-name';
import {
  deriveSessionTabRuntime,
  type WorkspaceSessionRuntimeSummary,
} from '@/client/lib/session-tab-runtime';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TabButton, TabList } from '@/components/ui/tab-button';
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
import { SessionNameEditor } from './session-name-editor';
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

function selectedChatLabel(
  sessions: Session[] | undefined,
  currentSessionId: string | null | undefined
) {
  const index = sessions?.findIndex((session) => session.id === currentSessionId) ?? -1;
  const current = sessions?.[index];
  return current ? getSessionDisplayName(current, `Chat ${index + 1}`) : null;
}

// =============================================================================
// Session Status Component
// =============================================================================

interface SessionTabStatusProps {
  sessionSummary?: WorkspaceSessionRuntimeSummary;
  isCIFix?: boolean;
  isAgent?: boolean;
  persistedStatus?: DbSessionStatus;
}

function SessionTabStatus({
  sessionSummary,
  isCIFix,
  isAgent,
  persistedStatus,
}: SessionTabStatusProps) {
  const status = deriveSessionTabRuntime(sessionSummary, persistedStatus);

  // CI fix sessions show wrench icon instead of the status icon, unless they need the user
  if (isCIFix && !status.awaitingInput) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center justify-center">
            <RatchetWrenchIcon
              enabled
              animated={status.isRunning}
              className="h-3.5 w-3.5 rounded-[4px] shrink-0"
              iconClassName={cn(
                status.isRunning && 'animate-pulse text-running',
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
          <SessionStatusIcon status={status} isAgent={isAgent} />
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
  tabStop: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

function TabItem({ tab, isActive, tabStop, onSelect, onClose }: TabItemProps) {
  const Icon = getTabIcon(tab.type);
  return (
    <TabButton
      icon={<Icon className="h-3.5 w-3.5 shrink-0" />}
      label={tab.label}
      isActive={isActive}
      tabStop={tabStop}
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
  tabStop: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRefresh: (selection: SubagentSelection) => void;
}

function SubagentTabItem({
  selection,
  label,
  isActive,
  tabStop,
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
          aria-label={`${subagent.status} subagent`}
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
      tabStop={tabStop}
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
  tabStop: boolean;
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
  tabStop,
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
        <SessionTabStatus
          sessionSummary={sessionSummary}
          isCIFix={isCIFix}
          isAgent={isAgent}
          persistedStatus={persistedStatus}
        />
      }
      label={label}
      isActive={isActive}
      tabStop={tabStop}
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
  /** A restart of the selected chat is in flight. */
  isRestartingSession?: boolean;
  /** A new chat is being created: "+" shows a spinner. */
  isCreatingSession?: boolean;
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
  isRestartingSession = false,
  isCreatingSession = false,
  disabled,
  maxSessions,
}: MainViewTabBarProps) {
  const tabBarRef = useTablistFocus();
  const { tabs, activeTabId, selectTab, closeTab, updateSubagentTab } = useWorkspacePanel();
  // The request outlives `closeConfirmOpen` so the dialog keeps its copy while
  // it animates closed.
  const [closeRequest, setCloseRequest] = useState<{
    sessionId: string;
    label: string;
    risk: SessionCloseRisk;
  } | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);

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
  const hasActiveFileTab = nonChatTabs.some((tab) => tab.id === activeTabId);
  const hasSelectedSession = Boolean(sessions?.some((session) => session.id === currentSessionId));
  const selectSession = (sessionId: string) => {
    onSelectSession?.(sessionId);
    selectTab('chat');
  };
  const stepSession = (step: 1 | -1) => {
    if (!sessions || sessions.length < 2) {
      return false;
    }
    const index = sessions.findIndex((session) => session.id === currentSessionId);
    const nextIndex =
      index < 0
        ? step === 1
          ? 0
          : sessions.length - 1
        : (index + step + sessions.length) % sessions.length;
    const next = sessions[nextIndex];
    if (!next) {
      return false;
    }
    selectSession(next.id);
    return true;
  };
  const canSwitchSessions = !disabled && (sessions?.length ?? 0) > 1;
  useShortcut('chat.next', () => stepSession(1), canSwitchSessions);
  useShortcut('chat.previous', () => stepSession(-1), canSwitchSessions);

  // Check if active session limit is reached
  const isAtLimit = isWorkspaceSessionLimitReached(sessions, maxSessions);
  // New sessions inherit the first session's provider/model, so wait for the list.
  const isButtonDisabled = disabled || isAtLimit || sessions === undefined;
  const currentSessionLabel = selectedChatLabel(sessions, currentSessionId);

  return (
    <div ref={tabBarRef} className={cn('flex items-center bg-shell', className)}>
      {/* Scrollable tab area. Chats and open files are separate tablists, each
          one Tab stop with arrow-key navigation; the menus between them are
          ordinary buttons, which a tablist may not contain. */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-hide p-1">
        {/* Session tabs (Chat 1, Chat 2, etc.) */}
        {sessions && sessions.length > 0 && (
          <TabList aria-label="Chats" className="shrink-0 gap-0.5">
            {sessions.map((session, index) => {
              const isSelected = session.id === currentSessionId;
              const baseLabel = getSessionDisplayName(session, `Chat ${index + 1}`);
              return (
                <SessionTabItem
                  key={session.id}
                  label={baseLabel}
                  isActive={isSelected && activeTabId === 'chat'}
                  tabStop={isSelected || (!hasSelectedSession && index === 0)}
                  sessionSummary={sessionSummariesById?.get(session.id)}
                  isCIFix={session.workflow === 'ci-fix'}
                  isAgent={session.workflow === 'periodic-task'}
                  persistedStatus={session.status}
                  onSelect={() => selectSession(session.id)}
                  onClose={
                    sessions.length > 1 ? () => requestCloseSession(session, baseLabel) : undefined
                  }
                />
              );
            })}
          </TabList>
        )}

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
        {nonChatTabs.length > 0 && <div className="h-4 w-px shrink-0 bg-border mx-1" />}

        {/* File/diff tabs */}
        {nonChatTabs.length > 0 && (
          <TabList aria-label="Open tabs" className="shrink-0 gap-0.5">
            {nonChatTabs.map((tab, index) => {
              const isActive = tab.id === activeTabId;
              const tabStop = isActive || (!hasActiveFileTab && index === 0);
              return tab.type === 'subagent' && tab.subagentSelection ? (
                <SubagentTabItem
                  key={tab.id}
                  selection={tab.subagentSelection}
                  label={tab.label}
                  isActive={isActive}
                  tabStop={tabStop}
                  onSelect={() => selectTab(tab.id)}
                  onClose={() => closeTab(tab.id)}
                  onRefresh={updateSubagentTab}
                />
              ) : (
                <TabItem
                  key={tab.id}
                  tab={tab}
                  isActive={isActive}
                  tabStop={tabStop}
                  onSelect={() => selectTab(tab.id)}
                  onClose={() => closeTab(tab.id)}
                />
              );
            })}
          </TabList>
        )}
      </div>

      {sessions
        ?.filter((session) => session.id === renamingSessionId)
        .map((session) => (
          <SessionNameEditor
            key={session.id}
            sessionId={session.id}
            workspaceId={workspaceId}
            name={getSessionDisplayName(session, `Chat ${sessions.indexOf(session) + 1}`)}
            onDone={() =>
              setRenamingSessionId((current) => (current === session.id ? null : current))
            }
          />
        ))}

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
                  pending={isCreatingSession}
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
            onRename={() => setRenamingSessionId(currentSessionId ?? null)}
            onRestartSession={onRestartSession}
            restartPending={isRestartingSession}
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
