import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { useWindowFocus } from '../../client/hooks/use-window-focus';
import { trpc } from '../../frontend/lib/trpc';

interface NotificationRequest {
  workspaceId: string;
  workspaceName: string;
  sessionCount: number;
  finishedAt: string;
}

const DEFAULT_SOUND_URL = '/sounds/workspace-complete.mp3';

/**
 * Manages workspace completion notifications.
 * Handles suppression logic based on window focus and visible workspace.
 */
export function WorkspaceNotificationManager() {
  const location = useLocation();
  const isWindowFocused = useWindowFocus();

  // Fetch user settings for playSoundOnComplete toggle
  const { data: settings, isSuccess: isSettingsLoaded } = trpc.userSettings.get.useQuery();

  // Fetch custom sound URL from settings
  const { data: soundInfo } = trpc.userSettings.getNotificationSoundUrl.useQuery(undefined, {
    staleTime: 60_000, // Cache for 1 minute to avoid excessive requests
  });

  // Use ref to store the sound URL so callbacks don't need to depend on it
  const soundUrlRef = useRef<string>(DEFAULT_SOUND_URL);
  useEffect(() => {
    soundUrlRef.current = soundInfo?.url ?? DEFAULT_SOUND_URL;
  }, [soundInfo?.url]);

  const playNotificationSound = useCallback(() => {
    try {
      const audio = new Audio(soundUrlRef.current);
      audio.volume = 0.5;
      audio.play().catch(() => {
        // Silently fail if autoplay is blocked
      });
    } catch {
      // Silently fail if audio doesn't load
    }
  }, []);

  const sendWorkspaceNotification = useCallback(
    (workspaceName: string, sessionCount: number, shouldPlaySound: boolean) => {
      // Play sound notification if enabled
      if (shouldPlaySound) {
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
    },
    [playNotificationSound]
  );

  const handleWorkspaceNotification = useCallback(
    (request: NotificationRequest) => {
      const { workspaceId, workspaceName, sessionCount } = request;

      // Suppression Logic
      const isChatVisible = location.pathname.includes(`/workspace/${workspaceId}`);
      const shouldSuppress = isWindowFocused || isChatVisible;

      if (shouldSuppress) {
        return;
      }

      // Only play sound if settings have loaded and user has it enabled
      // Default to true once settings are available, but don't play while loading
      // to avoid playing sound when user may have disabled it
      const playSoundOnComplete = isSettingsLoaded
        ? (settings?.playSoundOnComplete ?? true)
        : false;
      sendWorkspaceNotification(workspaceName, sessionCount, playSoundOnComplete);
    },
    [
      location.pathname,
      isWindowFocused,
      settings?.playSoundOnComplete,
      isSettingsLoaded,
      sendWorkspaceNotification,
    ]
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
