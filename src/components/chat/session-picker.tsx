import { Calendar, HardDrive, History } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SessionInfo } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface SessionPickerProps {
  sessions: SessionInfo[];
  currentSessionId: string | null;
  onLoadSession: (sessionId: string) => void;
  disabled?: boolean;
  className?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Formats a date string for display.
 */
function formatDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMs / 3_600_000);
    const diffDays = Math.floor(diffMs / 86_400_000);

    if (diffMins < 1) {
      return 'Just now';
    }
    if (diffMins < 60) {
      return `${diffMins}m ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    if (diffDays < 7) {
      return `${diffDays}d ago`;
    }

    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    // Invalid date string - return as-is rather than crashing
    return dateString;
  }
}

/**
 * Formats bytes to a human-readable size.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Truncates a Claude session ID for display.
 */
function truncateClaudeSessionId(claudeSessionId: string): string {
  if (claudeSessionId.length <= 12) {
    return claudeSessionId;
  }
  return `${claudeSessionId.slice(0, 8)}...${claudeSessionId.slice(-4)}`;
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Session picker dropdown for selecting from available sessions.
 */
export function SessionPicker({
  sessions,
  currentSessionId,
  onLoadSession,
  disabled = false,
  className,
}: SessionPickerProps) {
  // Sort sessions by modification date, most recent first
  const sortedSessions = [...sessions].sort((a, b) => {
    return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
  });

  const handleValueChange = (value: string) => {
    if (value && value !== currentSessionId) {
      onLoadSession(value);
    }
  };

  if (sessions.length === 0) {
    return (
      <div
        className={cn('flex items-center gap-2 text-sm text-muted-foreground px-3 py-2', className)}
      >
        <History className="h-4 w-4" />
        <span>No saved sessions</span>
      </div>
    );
  }

  return (
    <Select
      value={currentSessionId ?? undefined}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <SelectTrigger className={cn('w-[240px]', className)}>
        <div className="flex items-center gap-2">
          <History className="h-4 w-4" />
          <SelectValue placeholder="Select a session" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {sortedSessions.map((session) => {
          const isCurrent = session.claudeSessionId === currentSessionId;

          return (
            <SelectItem
              key={session.claudeSessionId}
              value={session.claudeSessionId}
              className="py-2"
            >
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className={cn('font-mono text-xs', isCurrent && 'font-medium')}>
                    {truncateClaudeSessionId(session.claudeSessionId)}
                  </span>
                  {isCurrent && <span className="text-xs text-primary">(current)</span>}
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    <span>{formatDate(session.modifiedAt)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <HardDrive className="h-3 w-3" />
                    <span>{formatBytes(session.sizeBytes)}</span>
                  </div>
                </div>
              </div>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
