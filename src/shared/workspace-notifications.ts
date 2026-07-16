/**
 * Shared helpers for parent/child workspace notification delivery.
 *
 * Notifications are persisted first (WorkspaceNotification row), then delivered
 * live when an active session exists. The queued-message id prefix lets the chat
 * dispatcher mark the row delivered after a successful send, and the transcript
 * marker lets session startup dedup a message that was already delivered live.
 */

export const WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX = 'workspace-notification-';

export function workspaceNotificationMessageId(notificationId: string): string {
  return `${WORKSPACE_NOTIFICATION_MESSAGE_ID_PREFIX}${notificationId}`;
}

/**
 * Build the exact user-message text enqueued for a workspace notification.
 * Live delivery and startup redelivery must produce identical text so the
 * transcript content match can detect an already-delivered notification.
 */
export function buildWorkspaceNotificationMessageText(notification: {
  id: string;
  direction: string;
  sourceWorkspaceName: string;
  message: string;
}): string {
  const label =
    notification.direction === 'PARENT_TO_CHILD'
      ? `[Message from parent workspace "${notification.sourceWorkspaceName}"]`
      : `[Message from child workspace "${notification.sourceWorkspaceName}"]`;
  return `${label}: ${notification.message}\n\n<!-- factory-factory-workspace-notification:${notification.id} -->`;
}
