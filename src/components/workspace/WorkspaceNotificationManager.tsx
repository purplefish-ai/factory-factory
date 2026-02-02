import { useCallback, useEffect } from 'react';
import { useLocation } from 'react-router';
import { useWindowFocus } from '../../client/hooks/use-window-focus';
import { trpc } from '../../frontend/lib/trpc';

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
  const { data: settings, isSuccess } = trpc.userSettings.get.useQuery();

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
      // Only play sound if settings have loaded and user has it enabled
      // Default to true once settings are available, but don't play while loading
      // to avoid playing sound when user may have disabled it
      const playSoundOnComplete = isSuccess ? (settings?.playSoundOnComplete ?? true) : false;
      sendWorkspaceNotification(workspaceName, sessionCount, playSoundOnComplete);
    },
    [location.pathname, isWindowFocused, settings?.playSoundOnComplete, isSuccess]
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

/**
 * Plays the workspace completion sound.
 */
function playNotificationSound(): void {
  try {
    const audio = new Audio('/sounds/workspace-complete.mp3');
    // Set a reasonable volume
    audio.volume = 0.5;
    // Play the sound (browsers may block autoplay, so we catch errors)
    audio.play().catch((_error) => {
      // Silently fail if autoplay is blocked
      // User can enable sound by interacting with the page first
    });
  } catch (_error) {
    // Silently fail if audio doesn't load
  }
}

function sendWorkspaceNotification(
  workspaceName: string,
  sessionCount: number,
  playSoundOnComplete: boolean
): void {
  // Play sound notification if enabled
  if (playSoundOnComplete) {
    playNotificationSound();
  }

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
