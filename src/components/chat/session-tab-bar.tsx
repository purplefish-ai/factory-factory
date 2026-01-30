'use client';

import type { SessionStatus } from '@prisma-gen/client';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface SessionData {
  id: string;
  status: SessionStatus;
  name?: string | null;
  createdAt: Date;
}

interface SessionTabBarProps {
  sessions: SessionData[];
  currentSessionId: string | null;
  runningSessionId?: string | null;
  onSelectSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onCloseSession: (sessionId: string) => void;
  disabled?: boolean;
  className?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Gets the display name for a session based on its index.
 */
function getSessionDisplayName(session: SessionData, index: number): string {
  if (session.name) {
    return session.name;
  }
  return `Session ${index + 1}`;
}

// =============================================================================
// Sub-Components
// =============================================================================

interface SessionTabProps {
  session: SessionData;
  displayName: string;
  isActive: boolean;
  isRunning: boolean;
  onSelect: () => void;
  onClose: () => void;
  disabled?: boolean;
}

function SessionTab({
  session,
  displayName,
  isActive,
  isRunning,
  onSelect,
  onClose,
  disabled,
}: SessionTabProps) {
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
      }
    },
    [disabled, onSelect]
  );

  return (
    <div
      role="tab"
      tabIndex={disabled ? -1 : 0}
      onClick={disabled ? undefined : onSelect}
      onKeyDown={handleKeyDown}
      aria-selected={isActive}
      aria-disabled={disabled}
      className={cn(
        'group relative flex items-center gap-2 px-3 py-1.5 text-sm font-medium cursor-pointer',
        'rounded-md transition-all whitespace-nowrap',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'border',
        isActive
          ? 'bg-background text-foreground shadow-md border-border'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground border-transparent',
        disabled && 'pointer-events-none opacity-50 cursor-default'
      )}
    >
      {/* Status indicator */}
      <div
        className={cn(
          'h-2 w-2 rounded-full shrink-0',
          isRunning && 'bg-brand animate-pulse',
          !isRunning && session.status === 'RUNNING' && 'bg-brand animate-pulse',
          !isRunning && session.status === 'IDLE' && 'bg-green-500',
          !isRunning && session.status === 'PAUSED' && 'bg-gray-400',
          !isRunning && session.status === 'COMPLETED' && 'bg-blue-500',
          !isRunning && session.status === 'FAILED' && 'bg-red-500'
        )}
      />

      <span className="truncate max-w-[120px]">{displayName}</span>

      {/* Close button - visible on hover */}
      <button
        type="button"
        onClick={handleClose}
        disabled={disabled}
        className={cn(
          'ml-1 rounded p-0.5 opacity-0 transition-opacity',
          'hover:bg-muted-foreground/20 focus-visible:opacity-100',
          'group-hover:opacity-100',
          disabled && 'pointer-events-none'
        )}
        aria-label={`Close ${displayName}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

export function SessionTabBar({
  sessions,
  currentSessionId,
  runningSessionId,
  onSelectSession,
  onCreateSession,
  onCloseSession,
  disabled = false,
  className,
}: SessionTabBarProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);

  // Sort sessions by creation date (oldest first for consistent numbering)
  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: We intentionally trigger on sessions.length changes to detect overflow
  useEffect(() => {
    updateScrollArrows();
    window.addEventListener('resize', updateScrollArrows);
    return () => window.removeEventListener('resize', updateScrollArrows);
  }, [updateScrollArrows, sessions.length]);

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
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
      )}

      {/* Scrollable tab container */}
      <div
        ref={scrollContainerRef}
        role="tablist"
        onScroll={handleScroll}
        className="flex items-center gap-1 overflow-x-auto scrollbar-none"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {sortedSessions.length === 0 ? (
          <div className="px-3 py-1.5 text-sm text-muted-foreground">No sessions</div>
        ) : (
          sortedSessions.map((session, index) => {
            const isActive = session.id === currentSessionId;
            const isRunning = session.id === runningSessionId;

            return (
              <SessionTab
                key={session.id}
                session={session}
                displayName={getSessionDisplayName(session, index)}
                isActive={isActive}
                isRunning={isRunning}
                onSelect={() => onSelectSession(session.id)}
                onClose={() => onCloseSession(session.id)}
                disabled={disabled}
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
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      )}

      {/* New session button */}
      <button
        type="button"
        onClick={onCreateSession}
        disabled={disabled}
        title="New Session"
        className="h-7 w-7 shrink-0 ml-1 flex items-center justify-center rounded-md transition-colors text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}
