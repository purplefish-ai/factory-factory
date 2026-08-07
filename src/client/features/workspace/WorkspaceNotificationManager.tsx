import { useCallback, useEffect, useRef } from 'react';
import { playSound } from '@/client/lib/sound';
import { trpc } from '@/client/lib/trpc';

interface NotificationRequest {
  workspaceId: string;
  workspaceName: string;
  sessionCount: number;
  finishedAt: string;
}

/**
 * Manages workspace completion notifications.
 * Plays a sound and shows a browser notification when a workspace completes.
 */
export function WorkspaceNotificationManager() {
  const { data: settings, isSuccess } = trpc.userSettings.get.useQuery();
  // Set by VoiceModeToggle (mounted separately, per open workspace chat) —
  // the completion chime is redundant, jarring noise on top of the agent's
  // spoken response while voice mode is active.
  const voiceModeActiveRef = useRef(false);

  useEffect(() => {
    const handleVoiceModeChanged = (event: CustomEvent<{ active: boolean }>) => {
      voiceModeActiveRef.current = event.detail.active;
    };
    window.addEventListener('voice-mode-changed', handleVoiceModeChanged as EventListener);
    return () => {
      window.removeEventListener('voice-mode-changed', handleVoiceModeChanged as EventListener);
    };
  }, []);

  const handleWorkspaceNotification = useCallback(
    (request: NotificationRequest) => {
      const { workspaceId, workspaceName, sessionCount } = request;

      // Only play sound if settings have loaded and user has it enabled
      // Default to true once settings are available, but don't play while loading
      // to avoid playing sound when user may have disabled it
      const playSoundOnComplete = isSuccess ? (settings?.playSoundOnComplete ?? true) : false;
      sendWorkspaceNotification(
        workspaceName,
        sessionCount,
        playSoundOnComplete && !voiceModeActiveRef.current
      );

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

  return null; // No UI, just notification logic
}

function sendWorkspaceNotification(
  workspaceName: string,
  sessionCount: number,
  playSoundOnComplete: boolean
): void {
  // Play sound notification if enabled
  if (playSoundOnComplete) {
    playSound('sounds/workspace-complete.mp3', { volume: 0.5 });
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
    icon: `${import.meta.env.BASE_URL}favicon.svg`,
    tag: `workspace-complete-${workspaceName}`, // Prevents duplicates
    requireInteraction: false,
  });
}
