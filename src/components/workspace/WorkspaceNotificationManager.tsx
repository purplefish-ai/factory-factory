import { useCallback, useEffect } from 'react';
import { trpc } from '@/frontend/lib/trpc';

interface NotificationRequest {
  workspaceId: string;
  workspaceName: string;
  sessionCount: number;
  finishedAt: string;
}

interface InputRequiredRequest {
  workspaceId: string;
  workspaceName: string;
  sessionId: string;
  requestType: 'permission_request' | 'user_question';
}

/**
 * Manages workspace completion notifications.
 * Plays a sound and shows a browser notification when a workspace completes.
 */
export function WorkspaceNotificationManager() {
  const { data: settings, isSuccess } = trpc.userSettings.get.useQuery();

  const handleWorkspaceNotification = useCallback(
    (request: NotificationRequest) => {
      const { workspaceId, workspaceName, sessionCount } = request;

      // Only play sound if settings have loaded and user has it enabled
      // Default to true once settings are available, but don't play while loading
      // to avoid playing sound when user may have disabled it
      const playSoundOnComplete = isSuccess ? (settings?.playSoundOnComplete ?? true) : false;
      sendWorkspaceNotification(workspaceName, sessionCount, playSoundOnComplete);

      // Dispatch attention event for red glow animation
      window.dispatchEvent(
        new CustomEvent('workspace-attention-required', {
          detail: { workspaceId },
        })
      );
    },
    [settings?.playSoundOnComplete, isSuccess]
  );

  const handleInputRequired = useCallback(
    (request: InputRequiredRequest) => {
      const { workspaceId, workspaceName, requestType } = request;

      const playSoundEnabled = isSuccess ? (settings?.playSoundOnComplete ?? true) : false;
      sendInputRequiredNotification(workspaceName, requestType, playSoundEnabled);

      // Dispatch attention event for red glow animation
      window.dispatchEvent(
        new CustomEvent('workspace-attention-required', {
          detail: { workspaceId },
        })
      );
    },
    [settings?.playSoundOnComplete, isSuccess]
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

  useEffect(() => {
    const handleInputRequiredEvent = (event: CustomEvent<InputRequiredRequest>) => {
      handleInputRequired(event.detail);
    };

    window.addEventListener('workspace-input-required', handleInputRequiredEvent as EventListener);

    return () => {
      window.removeEventListener(
        'workspace-input-required',
        handleInputRequiredEvent as EventListener
      );
    };
  }, [handleInputRequired]);

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

function sendInputRequiredNotification(
  workspaceName: string,
  requestType: 'permission_request' | 'user_question',
  playSoundEnabled: boolean
): void {
  if (playSoundEnabled) {
    playNotificationSound();
  }

  if (!('Notification' in window)) {
    return;
  }

  const message =
    requestType === 'user_question'
      ? 'Agent has a question and needs your input'
      : 'Agent needs permission to proceed';

  if (Notification.permission === 'granted') {
    new Notification(`Input Required: ${workspaceName}`, {
      body: message,
      icon: '/favicon.ico',
      tag: `workspace-input-${workspaceName}`,
      requireInteraction: false,
    });
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
