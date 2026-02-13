import type { SessionStatus as DbSessionStatus } from '@factory-factory/core';
import { Camera, FileCode, FileDiff, Plus } from 'lucide-react';

import { TabButton } from '@/components/ui/tab-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

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
  provider?: Session['provider'];
  isActive: boolean;
  sessionSummary?: WorkspaceSessionRuntimeSummary;
  isCIFix?: boolean;
  persistedStatus?: DbSessionStatus;
  onSelect: () => void;
  onClose?: () => void;
}

function getProviderLogoPaths(provider?: Session['provider']): {
  light: string;
  dark: string;
  alt: string;
} {
  if (provider === 'CODEX') {
    return {
      light: '/logos/codex-light.svg',
      dark: '/logos/codex-dark.svg',
      alt: 'Codex',
    };
  }
  return {
    light: '/logos/claude-light.svg',
    dark: '/logos/claude-dark.svg',
    alt: 'Claude',
  };
}

function SessionTabItem({
  label,
  provider,
  isActive,
  sessionSummary,
  isCIFix,
  persistedStatus,
  onSelect,
  onClose,
}: SessionTabItemProps) {
  const logo = getProviderLogoPaths(provider);
  return (
    <TabButton
      icon={
        <span className="flex items-center gap-1">
          <StatusDot
            sessionSummary={sessionSummary}
            isCIFix={isCIFix}
            persistedStatus={persistedStatus}
          />
          <img src={logo.light} alt={logo.alt} className="h-3.5 w-3.5 shrink-0 dark:hidden" />
          <img src={logo.dark} alt={logo.alt} className="hidden h-3.5 w-3.5 shrink-0 dark:block" />
        </span>
      }
      label={label}
      isActive={isActive}
      onSelect={onSelect}
      onClose={onClose}
      truncate
      iconSide="right"
    />
  );
}

// =============================================================================
// Main Component
// =============================================================================

interface MainViewTabBarProps {
  className?: string;
  sessions?: Session[];
  currentSessionId?: string | null;
  sessionSummariesById?: ReadonlyMap<string, WorkspaceSessionRuntimeSummary>;
  onSelectSession?: (sessionId: string) => void;
  onCreateSession?: () => void;
  onCloseSession?: (sessionId: string) => void;
  disabled?: boolean;
  /** Maximum sessions allowed per workspace */
  maxSessions?: number;
}

export function MainViewTabBar({
  className,
  sessions,
  currentSessionId,
  sessionSummariesById,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  disabled,
  maxSessions,
}: MainViewTabBarProps) {
  const { tabs, activeTabId, selectTab, closeTab } = useWorkspacePanel();

  // Filter out the default 'chat' tab since we're showing sessions instead
  const nonChatTabs = tabs.filter((tab) => tab.type !== 'chat');

  // Check if session limit is reached
  const sessionCount = sessions?.length ?? 0;
  const isAtLimit = maxSessions !== undefined && sessionCount >= maxSessions;
  const isButtonDisabled = disabled || isAtLimit;

  return (
    <div
      role="tablist"
      className={cn('flex items-center gap-0.5 bg-muted/50 p-1 overflow-x-auto', className)}
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
            provider={session.provider}
            isActive={isSelected && activeTabId === 'chat'}
            sessionSummary={sessionSummariesById?.get(session.id)}
            isCIFix={session.workflow === 'ci-fix'}
            persistedStatus={session.status}
            onSelect={() => {
              onSelectSession?.(session.id);
              selectTab('chat');
            }}
            onClose={sessions.length > 1 ? () => onCloseSession?.(session.id) : undefined}
          />
        );
      })}

      {/* Add session button */}
      {onCreateSession && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onCreateSession}
              disabled={isButtonDisabled}
              className={cn(
                'flex items-center justify-center h-6 w-6 rounded-md',
                'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
                'transition-colors disabled:opacity-50 disabled:pointer-events-none'
              )}
              aria-label="New chat session"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {isAtLimit ? `Maximum ${maxSessions} sessions per workspace` : 'New chat session'}
          </TooltipContent>
        </Tooltip>
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
  );
}
