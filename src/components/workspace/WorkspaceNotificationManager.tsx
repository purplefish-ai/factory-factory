import { useCallback, useEffect } from 'react';
import { useLocation } from 'react-router';
import { useWindowFocus } from '../../client/hooks/use-window-focus';

interface NotificationRequest {
  workspaceId: string;
  workspaceName: string;
  sessionCount: number;
  finishedAt: string;
}

/**
 * Manages workspace completion notifications.
 * Handles suppression logic based on window focus and visible workspace.
 */
export function WorkspaceNotificationManager() {
  const location = useLocation();
  const isWindowFocused = useWindowFocus();

  const handleWorkspaceNotification = useCallback(
    (request: NotificationRequest) => {
      const { workspaceId, workspaceName, sessionCount } = request;

      // Suppression Logic
      const isChatVisible = location.pathname.includes(`/workspace/${workspaceId}`);
      const shouldSuppress = isWindowFocused || isChatVisible;

      if (shouldSuppress) {
        return;
      }

      // Send notification
      sendWorkspaceNotification(workspaceName, sessionCount);
    },
    [location.pathname, isWindowFocused]
  );

  useEffect(() => {
    // Listen for notification requests from backend
    const handleNotificationRequest = (event: CustomEvent<NotificationRequest>) => {
      const request = event.detail;
      handleWorkspaceNotification(request);
    };

    window.addEventListener(
      'workspace-notification-request',
      handleNotificationRequest as EventListener
    );

    return () => {
      window.removeEventListener(
        'workspace-notification-request',
        handleNotificationRequest as EventListener
      );
    };
  }, [handleWorkspaceNotification]);

  return null; // No UI, just notification logic
}

function sendWorkspaceNotification(workspaceName: string, sessionCount: number): void {
  if (!('Notification' in window)) {
    return;
  }

  // Request permission if needed
  if (Notification.permission === 'default') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        showNotification(workspaceName, sessionCount);
      }
    });
  } else if (Notification.permission === 'granted') {
    showNotification(workspaceName, sessionCount);
  }
}

function showNotification(workspaceName: string, sessionCount: number): void {
  const message =
    sessionCount === 1
      ? 'Agent finished and is ready for your attention'
      : `All ${sessionCount} agents finished and ready for your attention`;

  new Notification(`Workspace Ready: ${workspaceName}`, {
    body: message,
    icon: '/favicon.ico',
    tag: `workspace-complete-${workspaceName}`, // Prevents duplicates
    requireInteraction: false,
  });
}
