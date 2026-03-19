import { Archive, Camera, FileCode, FileDiff, Plus, RefreshCw } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { TabButton } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  EXPLICIT_SESSION_PROVIDER_OPTIONS,
  getSessionProviderLabel,
  type SessionProviderValue,
} from '@/lib/session-provider-selection';
import { cn } from '@/lib/utils';
import type { SessionStatus as DbSessionStatus } from '@/shared/core';
import { ClosedSessionsDropdown } from './closed-sessions-dropdown';
import { QuickActionsMenu } from './quick-actions-menu';
import { RatchetWrenchIcon } from './ratchet-wrench-icon';
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
      return FileCode;
    case 'diff':
      return FileDiff;
    case 'screenshot':
      return Camera;
    case 'closed-session':
      return Archive;
  }
}

// =============================================================================
// Status Dot Component
// =============================================================================

interface StatusDotProps {
  sessionSummary?: WorkspaceSessionRuntimeSummary;
  isCIFix?: boolean;
  persistedStatus?: DbSessionStatus;
}

function StatusDot({ sessionSummary, isCIFix, persistedStatus }: StatusDotProps) {
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
        <span className="flex items-center justify-center w-3.5 h-3.5">
          <StatusIcon
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              status.color,
              status.pulse && 'animate-pulse',
              status.spin && 'animate-spin'
            )}
          />
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

// =============================================================================
// Session Tab Item
// =============================================================================

interface SessionTabItemProps {
  label: string;
  isActive: boolean;
  sessionSummary?: WorkspaceSessionRuntimeSummary;
  isCIFix?: boolean;
  persistedStatus?: DbSessionStatus;
  hasUnread?: boolean;
  onSelect: () => void;
  onClose?: () => void;
}

function SessionTabItem({
  label,
  isActive,
  sessionSummary,
  isCIFix,
  persistedStatus,
  hasUnread,
  onSelect,
  onClose,
}: SessionTabItemProps) {
  return (
    <div className="relative">
      <TabButton
        icon={
          <StatusDot
            sessionSummary={sessionSummary}
            isCIFix={isCIFix}
            persistedStatus={persistedStatus}
          />
        }
        label={label}
        isActive={isActive}
        onSelect={onSelect}
        onClose={onClose}
        truncate
      />
      {hasUnread && (
        <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-blue-500 pointer-events-none" />
      )}
    </div>
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
  sessionSummariesById?: ReadonlyMap<string, WorkspaceSessionRuntimeSummary>;
  unreadSessionIds?: Set<string>;
  onSelectSession?: (sessionId: string) => void;
  onCreateSession?: () => void;
  onCloseSession?: (sessionId: string) => void;
  onQuickAction?: (name: string, prompt: string) => void;
  onSelectClosedSession?: (sessionId: string) => void;
  onRestartSession?: () => void;
  disabled?: boolean;
  /** Maximum sessions allowed per workspace */
  maxSessions?: number;
  selectedProvider: SessionProviderValue;
  setSelectedProvider: Dispatch<SetStateAction<SessionProviderValue>>;
}

export function MainViewTabBar({
  className,
  workspaceId,
  sessions,
  currentSessionId,
  sessionSummariesById,
  unreadSessionIds,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  onQuickAction,
  onSelectClosedSession,
  onRestartSession,
  disabled,
  maxSessions,
  selectedProvider,
  setSelectedProvider,
}: MainViewTabBarProps) {
  const { tabs, activeTabId, selectTab, closeTab } = useWorkspacePanel();

  // Filter out the default 'chat' tab since we're showing sessions instead
  const nonChatTabs = tabs.filter((tab) => tab.type !== 'chat');

  // Check if session limit is reached
  const sessionCount = sessions?.length ?? 0;
  const isAtLimit = maxSessions !== undefined && sessionCount >= maxSessions;
  const isButtonDisabled = disabled || isAtLimit;
  const providerTriggerLabel = getSessionProviderLabel(selectedProvider);

  return (
    <div className={cn('flex items-center bg-muted/50', className)}>
      {/* Scrollable tab area */}
      <div
        role="tablist"
        className="flex flex-1 min-w-0 items-center gap-0.5 p-1 overflow-x-auto"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {/* Session tabs (Chat 1, Chat 2, etc.) */}
        {sessions?.map((session, index) => {
          const isSelected = session.id === currentSessionId;
          const baseLabel = session.name ?? `Chat ${index + 1}`;
          return (
            <SessionTabItem
              key={session.id}
              label={baseLabel}
              isActive={isSelected && activeTabId === 'chat'}
              sessionSummary={sessionSummariesById?.get(session.id)}
              isCIFix={session.workflow === 'ci-fix'}
              persistedStatus={session.status}
              hasUnread={!isSelected && unreadSessionIds?.has(session.id)}
              onSelect={() => {
                onSelectSession?.(session.id);
                selectTab('chat');
              }}
              onClose={sessions.length > 1 ? () => onCloseSession?.(session.id) : undefined}
            />
          );
        })}

        {/* Session creation controls (provider + add button) */}
        {onCreateSession && (
          <div className="ml-0.5 flex shrink-0 items-center overflow-hidden rounded-md border border-input bg-background">
            <Select
              value={selectedProvider}
              onValueChange={(value) => {
                setSelectedProvider(value === 'CODEX' ? 'CODEX' : 'CLAUDE');
              }}
              disabled={isButtonDisabled}
            >
              <SelectTrigger
                aria-label="New session provider"
                className="h-7 w-auto shrink-0 rounded-none border-0 border-r border-input px-2 text-xs focus:ring-0 [&>svg]:hidden"
              >
                <span>{providerTriggerLabel}</span>
              </SelectTrigger>
              <SelectContent>
                {EXPLICIT_SESSION_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onCreateSession}
                  disabled={isButtonDisabled}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-none',
                    'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                    'transition-colors disabled:pointer-events-none disabled:opacity-50'
                  )}
                  aria-label={`New ${providerTriggerLabel} session`}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {isAtLimit
                  ? `Maximum ${maxSessions} sessions per workspace`
                  : `New ${providerTriggerLabel} session`}
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        {onQuickAction && (
          <div className="ml-0.5 shrink-0">
            <QuickActionsMenu
              onExecuteAgent={(action) => {
                if (action.content) {
                  onQuickAction(action.name, action.content);
                }
              }}
              disabled={isButtonDisabled}
            />
          </div>
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
        {nonChatTabs.length > 0 && <div className="h-4 w-px bg-border mx-1" />}

        {/* File/diff tabs */}
        {nonChatTabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onSelect={() => selectTab(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}
      </div>

      {/* Restart button — pinned to the right, outside the scrollable area */}
      {onRestartSession && (
        <div className="shrink-0 pr-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onRestartSession}
                disabled={disabled}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium',
                  'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                  'transition-colors disabled:pointer-events-none disabled:opacity-50'
                )}
                aria-label="Restart agent"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Restart
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Stop and restart the agent, resuming from where it left off
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
