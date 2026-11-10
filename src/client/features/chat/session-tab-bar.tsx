import { CaretLeftIcon } from '@phosphor-icons/react/dist/csr/CaretLeft';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SessionStatusIcon } from '@/client/components/session-status-icon';
import { NewSessionAccountAction } from '@/client/features/session-selection';
import { useTablistFocus } from '@/client/hooks/use-tablist-focus';
import { getSessionDisplayName } from '@/client/lib/session-display-name';
import { deriveSessionTabRuntime } from '@/client/lib/session-tab-runtime';
import { Button } from '@/components/ui/button';
import { TabButton, TabList } from '@/components/ui/tab-button';
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
  /** A new session is being created: the new-session button shows a spinner. */
  createPending?: boolean;
  className?: string;
  readOnly?: boolean;
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
  // Quick chat has no runtime summaries, so the persisted status (or the
  // running session) drives the same status map as the workspace tab bar.
  const status = deriveSessionTabRuntime(undefined, isRunning ? 'RUNNING' : session.status);
  return (
    <TabButton
      icon={<SessionStatusIcon status={status} isAgent={session.workflow === 'periodic-task'} />}
      label={displayName}
      title={status.label}
      isActive={isActive}
      tabStop={tabStop}
      onSelect={onSelect}
      onClose={readOnly ? undefined : onClose}
      disabled={disabled}
      truncate
    />
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
  createPending = false,
  className,
  readOnly = false,
}: SessionTabBarProps) {
  const tabBarRef = useTablistFocus();
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
    <div
      ref={tabBarRef}
      className={cn('flex items-center gap-1 bg-shell rounded-lg p-1', className)}
    >
      {/* Left scroll arrow */}
      {showLeftArrow && (
        <Button
          variant="ghost"
          size="icon-compact"
          onClick={scrollLeft}
          disabled={disabled}
          aria-label="Scroll session tabs left"
        >
          <CaretLeftIcon />
        </Button>
      )}

      {/* Scrollable tab container */}
      <TabList
        ref={scrollContainerRef}
        aria-label="Chats"
        onScroll={handleScroll}
        className="min-w-0 flex-1 gap-1 overflow-x-auto scrollbar-hide"
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
      </TabList>

      {/* Right scroll arrow */}
      {showRightArrow && (
        <Button
          variant="ghost"
          size="icon-compact"
          onClick={scrollRight}
          disabled={disabled}
          aria-label="Scroll session tabs right"
        >
          <CaretRightIcon />
        </Button>
      )}

      {/* New session button — hidden in readOnly mode */}
      {!readOnly && (
        <NewSessionAccountAction
          provider={sessions[0]?.provider ?? workspaceProvider}
          onCreate={onCreateSession}
          disabled={disabled || createDisabled}
          pending={createPending}
        />
      )}
    </div>
  );
}
