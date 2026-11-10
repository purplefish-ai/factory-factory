import { useEffect, useState } from 'react';
import { QueryState } from '@/client/components/query-state';
import { usePersistedState } from '@/client/hooks/use-persisted-state';
import {
  BROWSER_NOTIFICATIONS_KEY,
  BrowserNotificationsEnabledSchema,
  readNotificationPermission,
  writeBrowserNotificationsEnabled,
} from '@/client/lib/browser-notifications';
import { useUpdateUserSettings, useUserSettings } from '@/client/lib/user-settings-queries';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SettingRow, SettingsSection } from './settings-section';

function notificationDescription(
  permission: ReturnType<typeof readNotificationPermission>,
  requesting: boolean,
  enabled: boolean
): string {
  if (permission === 'unsupported') {
    return "This browser doesn't support desktop notifications.";
  }
  if (permission === 'denied') {
    return 'Notifications are blocked. Allow them in your browser settings, then return here.';
  }
  if (requesting) {
    return 'Waiting for notification permission…';
  }
  if (enabled && permission === 'granted') {
    return 'On for this browser. Select a notification to open its workspace.';
  }
  return 'Off for this browser. Turn on to receive workspace completion notifications.';
}

export function NotificationSettingsSection() {
  const settingsQuery = useUserSettings();
  const updateSettings = useUpdateUserSettings();
  const [enabled] = usePersistedState(
    BROWSER_NOTIFICATIONS_KEY,
    BrowserNotificationsEnabledSchema,
    false,
    { crossTab: true }
  );
  const [permission, setPermission] = useState(readNotificationPermission);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => setPermission(readNotificationPermission());
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const enableDesktop = async () => {
    setError(null);
    if (permission === 'unsupported' || permission === 'denied') {
      return;
    }
    setRequesting(true);
    try {
      // Invoke before any await: permission prompts require the user's gesture.
      const result = permission === 'granted' ? 'granted' : await Notification.requestPermission();
      setPermission(result);
      if (result === 'granted') {
        writeBrowserNotificationsEnabled(true);
      } else if (result === 'default') {
        setError("Notifications weren't enabled. Turn on notifications to try again.");
      }
    } catch {
      setError("Couldn't enable notifications. Try again.");
    } finally {
      setRequesting(false);
    }
  };
  const toggleDesktop = (checked: boolean) => {
    if (checked) {
      void enableDesktop();
      return;
    }
    setError(null);
    try {
      writeBrowserNotificationsEnabled(false);
    } catch {
      setError("Couldn't turn off notifications. Try again.");
    }
  };
  const description = notificationDescription(permission, requesting, enabled);

  return (
    <SettingsSection
      title="Notifications"
      description="Choose how to hear about workspace completions."
    >
      <SettingRow
        label="Desktop notifications"
        htmlFor="desktop-notifications-toggle"
        description={<span role="status">{description}</span>}
        descriptionId="desktop-notifications-description"
        message={
          error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null
        }
      >
        <Switch
          id="desktop-notifications-toggle"
          aria-describedby="desktop-notifications-description"
          checked={enabled && permission === 'granted'}
          onCheckedChange={toggleDesktop}
          disabled={requesting || permission === 'unsupported' || permission === 'denied'}
        />
      </SettingRow>
      <QueryState
        query={settingsQuery}
        errorTitle="Couldn't load notification settings"
        loading={<Skeleton className="h-10 w-full" />}
      >
        {(settings) => (
          <SettingRow
            label="Play completion sound"
            htmlFor="sound-toggle"
            description="Play a sound when a workspace finishes."
            descriptionId="sound-toggle-description"
            saving={updateSettings.isSaving('playSoundOnComplete')}
          >
            <Switch
              id="sound-toggle"
              aria-describedby="sound-toggle-description"
              checked={settings.playSoundOnComplete}
              onCheckedChange={(checked) => updateSettings.mutate({ playSoundOnComplete: checked })}
            />
          </SettingRow>
        )}
      </QueryState>
    </SettingsSection>
  );
}
