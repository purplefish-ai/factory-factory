'use client';

import { Bell, X } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import type { TaskNotification } from './chat-reducer';

// =============================================================================
// Props
// =============================================================================

export interface TaskNotificationsPanelProps {
  /** Task notifications to display */
  notifications: TaskNotification[];
  /** Callback to dismiss a single notification */
  onDismiss?: (id: string) => void;
  /** Callback to clear all notifications */
  onClearAll?: () => void;
  /** Optional className for additional styling */
  className?: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Format a timestamp as a relative time string (e.g., "2m ago", "just now").
 */
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 10) {
    return 'just now';
  }
  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// =============================================================================
// Notification Item Component
// =============================================================================

interface NotificationItemProps {
  notification: TaskNotification;
  onDismiss?: () => void;
}

const NotificationItem = memo(function NotificationItem({
  notification,
  onDismiss,
}: NotificationItemProps) {
  return (
    <div className="flex items-start gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50 group">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground truncate">{notification.message}</p>
        <p className="text-[10px] text-muted-foreground">
          {formatRelativeTime(notification.timestamp)}
        </p>
      </div>
      {onDismiss && (
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          onClick={onDismiss}
          aria-label="Dismiss notification"
        >
          <X className="h-3 w-3" />
        </Button>
      )}
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

/**
 * Displays task notifications from the SDK (e.g., subagent updates).
 * Notifications can be dismissed individually or cleared all at once.
 */
export const TaskNotificationsPanel = memo(function TaskNotificationsPanel({
  notifications,
  onDismiss,
  onClearAll,
  className,
}: TaskNotificationsPanelProps) {
  // Memoize the dismiss handlers to prevent unnecessary re-renders
  const handleDismiss = useCallback(
    (id: string) => () => {
      onDismiss?.(id);
    },
    [onDismiss]
  );

  // Reverse notifications to show newest first
  const reversedNotifications = useMemo(() => [...notifications].reverse(), [notifications]);

  // Don't render if there are no notifications
  if (notifications.length === 0) {
    return null;
  }

  return (
    <div className={className}>
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm">
        <div className="p-2 space-y-1">
          {/* Header */}
          <div className="flex items-center justify-between px-2 py-1">
            <div className="flex items-center gap-2">
              <Bell className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">
                Notifications ({notifications.length})
              </span>
            </div>
            {onClearAll && notifications.length > 1 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={onClearAll}
              >
                Clear all
              </Button>
            )}
          </div>

          {/* Notification List */}
          <div className="space-y-0.5 max-h-32 overflow-y-auto">
            {reversedNotifications.map((notification) => (
              <NotificationItem
                key={notification.id}
                notification={notification}
                onDismiss={onDismiss ? handleDismiss(notification.id) : undefined}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});
