import { FileCode, FileDiff, Plus, Wrench } from 'lucide-react';

import type { ProcessStatus, SessionStatus } from '@/components/chat/reducer';
import { PanelTab } from '@/components/ui/panel-tab';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { MainViewTab } from './workspace-panel-context';
import { useWorkspacePanel } from './workspace-panel-context';

// =============================================================================
// Types
// =============================================================================

interface Session {
  id: string;
  name: string | null;
  workflow?: string;
  isWorking?: boolean;
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
  }
}

// =============================================================================
// Status Dot Component
// =============================================================================

interface StatusInfo {
  color: string;
  pulse: boolean;
  label: string;
  description: string;
}

function getStatusInfo(
  sessionStatus: SessionStatus | undefined,
  processStatus: ProcessStatus | undefined,
  isRunning: boolean
): StatusInfo {
  // For non-selected sessions, we only know if they're running
  if (!(sessionStatus && processStatus)) {
    if (isRunning) {
      return {
        color: 'bg-brand',
        pulse: true,
        label: 'Running',
        description: 'Processing a request',
      };
    }
    return {
      color: 'bg-emerald-500',
      pulse: false,
      label: 'Idle',
      description: 'Ready for input',
    };
  }

  // For selected session, use detailed status
  const phase = sessionStatus.phase;

  if (phase === 'loading' || processStatus.state === 'unknown') {
    return {
      color: 'bg-muted-foreground',
      pulse: true,
      label: 'Loading',
      description: 'Loading session...',
    };
  }

  if (phase === 'starting') {
    return {
      color: 'bg-muted-foreground',
      pulse: true,
      label: 'Starting',
      description: 'Launching Claude...',
    };
  }

  if (phase === 'stopping') {
    return {
      color: 'bg-brand',
      pulse: true,
      label: 'Stopping',
      description: 'Finishing current request...',
    };
  }

  if (processStatus.state === 'stopped') {
    if (processStatus.lastExit?.unexpected) {
      return {
        color: 'bg-destructive',
        pulse: false,
        label: 'Error',
        description: `Exited unexpectedly${processStatus.lastExit.code !== null ? ` (code ${processStatus.lastExit.code})` : ''}`,
      };
    }
    return {
      color: 'bg-muted-foreground',
      pulse: false,
      label: 'Stopped',
      description: 'Send a message to start',
    };
  }

  if (phase === 'running') {
    return {
      color: 'bg-brand',
      pulse: true,
      label: 'Running',
      description: 'Processing your request',
    };
  }

  // idle or ready
  return {
    color: 'bg-emerald-500',
    pulse: false,
    label: 'Idle',
    description: 'Ready for input',
  };
}

interface StatusDotProps {
  sessionStatus?: SessionStatus;
  processStatus?: ProcessStatus;
  isRunning: boolean;
  isCIFix?: boolean;
}

function StatusDot({ sessionStatus, processStatus, isRunning, isCIFix }: StatusDotProps) {
  const status = getStatusInfo(sessionStatus, processStatus, isRunning);

  // CI fix sessions show wrench icon instead of dot
  if (isCIFix) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center justify-center">
            <Wrench
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                isRunning && 'animate-pulse text-brand',
                !isRunning && 'text-warning'
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
          <span
            className={cn(
              'w-2 h-2 rounded-full shrink-0',
              status.color,
              status.pulse && 'animate-pulse'
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
    <PanelTab
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
  isRunning?: boolean;
  isCIFix?: boolean;
  sessionStatus?: SessionStatus;
  processStatus?: ProcessStatus;
  onSelect: () => void;
  onClose?: () => void;
}

function SessionTabItem({
  label,
  isActive,
  isRunning,
  isCIFix,
  sessionStatus,
  processStatus,
  onSelect,
  onClose,
}: SessionTabItemProps) {
  return (
    <PanelTab
      icon={
        <StatusDot
          sessionStatus={sessionStatus}
          processStatus={processStatus}
          isRunning={isRunning ?? false}
          isCIFix={isCIFix}
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
  sessions?: Session[];
  currentSessionId?: string | null;
  runningSessionId?: string;
  /** Session status for the currently selected session */
  sessionStatus?: SessionStatus;
  /** Process status for the currently selected session */
  processStatus?: ProcessStatus;
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
  runningSessionId,
  sessionStatus,
  processStatus,
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
        return (
          <SessionTabItem
            key={session.id}
            label={session.name ?? `Chat ${index + 1}`}
            isActive={isSelected && activeTabId === 'chat'}
            isRunning={session.isWorking || session.id === runningSessionId}
            isCIFix={session.workflow === 'ci-fix'}
            sessionStatus={isSelected ? sessionStatus : undefined}
            processStatus={isSelected ? processStatus : undefined}
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
