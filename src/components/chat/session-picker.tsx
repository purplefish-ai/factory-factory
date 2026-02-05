import { Calendar, HardDrive, History } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SessionInfo } from '@/lib/claude-types';
import { formatBytes, formatRelativeDateShort } from '@/lib/formatters';
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
                    <span>{formatRelativeDateShort(session.modifiedAt)}</span>
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
