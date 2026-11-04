import { CaretLeftIcon } from '@phosphor-icons/react/dist/csr/CaretLeft';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { PauseCircleIcon } from '@phosphor-icons/react/dist/csr/PauseCircle';
import { PulseIcon } from '@phosphor-icons/react/dist/csr/Pulse';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AgentSessionStatus } from '@/client/components/agent-session-status';
import { NewSessionAccountAction } from '@/client/features/session-selection';
import { getAriaKeyShortcuts, matchesShortcut } from '@/client/lib/keyboard-shortcuts';
import { handleTablistKeyDown } from '@/client/lib/roving-tablist';
import { getSessionDisplayName } from '@/client/lib/session-display-name';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SessionStatus } from '@/shared/core';

// =============================================================================
// Types
// =============================================================================

export interface SessionData {
  id: string;
  status: SessionStatus;
  name?: string | null;
  workflow?: string | null;
  createdAt: Date;
  provider?: 'CLAUDE' | 'CODEX';
}

interface SessionTabBarProps {
  sessions: SessionData[];
  workspaceProvider?: 'CLAUDE' | 'CODEX';
  currentSessionId: string | null;
  runningSessionId?: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: (codexAccountId?: string) => void;
  onCloseSession: (sessionId: string) => void;
  disabled?: boolean;
  createDisabled?: boolean;
  className?: string;
  readOnly?: boolean;
}

// =============================================================================
// Helper Functions
// =============================================================================

function getStatusIcon(status: SessionStatus, isRunning: boolean) {
  if (isRunning || status === 'RUNNING') {
    return PulseIcon;
  }
  if (status === 'IDLE') {
    return CircleIcon;
  }
  if (status === 'PAUSED') {
    return PauseCircleIcon;
  }
  if (status === 'COMPLETED') {
    return CheckCircleIcon;
  }
  return XCircleIcon;
}

function getStatusIconClass(status: SessionStatus, isRunning: boolean) {
  if (isRunning || status === 'RUNNING') {
    return 'text-running';
  }
  if (status === 'IDLE') {
    return 'text-muted-foreground';
  }
  if (status === 'PAUSED') {
    return 'text-muted-foreground';
  }
  if (status === 'COMPLETED') {
    return 'text-success';
  }
  return 'text-destructive';
}

// =============================================================================
// Sub-Components
// =============================================================================

interface SessionTabProps {
  session: SessionData;
  displayName: string;
  isActive: boolean;
  /** The tablist's single Tab stop (roving tabindex). */
  tabStop: boolean;
  isRunning: boolean;
  onSelect: () => void;
  onClose: () => void;
  disabled?: boolean;
  readOnly?: boolean;
}

function SessionTab({
  session,
  displayName,
  isActive,
  tabStop,
  isRunning,
  onSelect,
  onClose,
  disabled,
  readOnly,
}: SessionTabProps) {
  const isAgent = session.workflow === 'periodic-task';
  const StatusIcon = getStatusIcon(session.status, isRunning);
  const statusLabel = isRunning
    ? 'Running'
    : session.status[0] + session.status.slice(1).toLowerCase();

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) {
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      } else if (!readOnly && matchesShortcut(e, 'tabs.close')) {
        e.preventDefault();
        onClose();
      }
    },
    [disabled, onSelect, onClose, readOnly]
  );

  // The close button is the tab's sibling rather than its child (interactive
  // controls must not nest); it stays out of the Tab order because Delete
  // closes the focused tab.
  return (
    <div
      className={cn(
        'group relative flex items-center text-sm font-medium',
        'rounded-md transition-all whitespace-nowrap border',
        'has-[[role=tab]:focus-visible]:ring-2 has-[[role=tab]:focus-visible]:ring-ring has-[[role=tab]:focus-visible]:ring-offset-2',
        isActive
          ? 'bg-background text-foreground shadow-md border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      <div
        role="tab"
        tabIndex={tabStop && !disabled ? 0 : -1}
        onClick={disabled ? undefined : onSelect}
        onKeyDown={handleKeyDown}
        title={isRunning ? 'Running' : session.status}
        aria-selected={isActive}
        aria-disabled={disabled}
        aria-keyshortcuts={readOnly ? undefined : getAriaKeyShortcuts('tabs.close')}
        className={cn(
          'flex min-w-0 items-center gap-2 py-1.5 px-3 outline-none',
          disabled ? 'cursor-default' : 'cursor-pointer'
        )}
      >
        {/* Status indicator */}
        {isAgent ? (
          <AgentSessionStatus
            label={statusLabel}
            icon={StatusIcon}
            color={getStatusIconClass(session.status, isRunning)}
            pulse={isRunning || session.status === 'RUNNING'}
          />
        ) : (
          <StatusIcon
            className={cn(
              'h-3.5 w-3.5 shrink-0',
              getStatusIconClass(session.status, isRunning),
              (isRunning || session.status === 'RUNNING') && 'animate-pulse'
            )}
          />
        )}

        <span className="truncate max-w-[120px]">{displayName}</span>
      </div>

      {/* Close button - visible on hover, hidden in readOnly mode */}
      {!readOnly && (
        <button
          type="button"
          tabIndex={-1}
          onClick={handleClose}
          disabled={disabled}
          className={cn(
            'mr-3 rounded p-0.5 transition-opacity',
            'hover-reveal',
            'hover:bg-muted-foreground/20',
            disabled && 'pointer-events-none'
          )}
          aria-label={`Close ${displayName}`}
        >
          <XIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function SessionTabBar({
  sessions,
  currentSessionId,
  workspaceProvider,
  runningSessionId,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  disabled = false,
  createDisabled = false,
  className,
  readOnly = false,
}: SessionTabBarProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);

  // Sort sessions by creation date (oldest first for consistent numbering)
  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const hasActiveSession = sortedSessions.some((session) => session.id === currentSessionId);

  // Check for overflow and update arrow visibility
  const updateScrollArrows = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const { scrollLeft, scrollWidth, clientWidth } = container;
    setShowLeftArrow(scrollLeft > 0);
    setShowRightArrow(scrollLeft + clientWidth < scrollWidth - 1);
  }, []);

  // Update arrows on mount and when sessions change
  useEffect(() => {
    updateScrollArrows();
    window.addEventListener('resize', updateScrollArrows);
    return () => window.removeEventListener('resize', updateScrollArrows);
  }, [updateScrollArrows]);

  useLayoutEffect(() => {
    if (sortedSessions.length === 0) {
      setShowLeftArrow(false);
      setShowRightArrow(false);
      return;
    }
    updateScrollArrows();
  }, [sortedSessions.length, updateScrollArrows]);

  // Scroll handlers
  const scrollLeft = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollBy({ left: -150, behavior: 'smooth' });
    }
  }, []);

  const scrollRight = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollBy({ left: 150, behavior: 'smooth' });
    }
  }, []);

  // Handle scroll event
  const handleScroll = useCallback(() => {
    updateScrollArrows();
  }, [updateScrollArrows]);

  return (
    <div className={cn('flex items-center gap-1 bg-muted rounded-lg p-1', className)}>
      {/* Left scroll arrow */}
      {showLeftArrow && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={scrollLeft}
          disabled={disabled}
          aria-label="Scroll session tabs left"
        >
          <CaretLeftIcon className="h-4 w-4" />
        </Button>
      )}

      {/* Scrollable tab container */}
      <div
        ref={scrollContainerRef}
        role="tablist"
        aria-label="Chats"
        onKeyDown={handleTablistKeyDown}
        onScroll={handleScroll}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {sortedSessions.length === 0 ? (
          <div role="presentation" className="px-3 py-1.5 text-sm text-muted-foreground">
            No sessions
          </div>
        ) : (
          sortedSessions.map((session, index) => {
            const isActive = session.id === currentSessionId;
            const isRunning = session.id === runningSessionId;

            return (
              <SessionTab
                key={session.id}
                session={session}
                displayName={getSessionDisplayName(session, `Session ${index + 1}`)}
                isActive={isActive}
                tabStop={isActive || (!hasActiveSession && index === 0)}
                isRunning={isRunning}
                onSelect={() => onSelectSession(session.id)}
                onClose={() => onCloseSession(session.id)}
                disabled={disabled}
                readOnly={readOnly}
              />
            );
          })
        )}
      </div>

      {/* Right scroll arrow */}
      {showRightArrow && (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={scrollRight}
          disabled={disabled}
          aria-label="Scroll session tabs right"
        >
          <CaretRightIcon className="h-4 w-4" />
        </Button>
      )}

      {/* New session button — hidden in readOnly mode */}
      {!readOnly && (
        <NewSessionAccountAction
          provider={sessions[0]?.provider ?? workspaceProvider}
          onCreate={onCreateSession}
          disabled={disabled || createDisabled}
        />
      )}
    </div>
  );
}
