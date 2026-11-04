import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import {
  readBrowserNotificationsEnabled,
  readNotificationPermission,
  subscribeBrowserNotifications,
  writeBrowserNotificationsEnabled,
} from '@/client/lib/browser-notifications';
import { trpc } from '@/client/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

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
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const enabled = useSyncExternalStore(
    subscribeBrowserNotifications,
    readBrowserNotificationsEnabled,
    () => false
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
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      runInBackground(
        utils.userSettings.get.invalidate(),
        "Couldn't refresh notification settings."
      );
    },
    onError: (error) => {
      toast.error(`Couldn't update notification settings: ${error.message}`);
    },
  });

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
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Choose how to hear about workspace completions.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="desktop-notifications-toggle">Desktop notifications</Label>
            <p
              id="desktop-notifications-description"
              className="text-sm text-muted-foreground"
              role="status"
            >
              {description}
            </p>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <Switch
            id="desktop-notifications-toggle"
            aria-describedby="desktop-notifications-description"
            checked={enabled && permission === 'granted'}
            onCheckedChange={(checked) => {
              void toggleDesktop(checked);
            }}
            disabled={requesting || permission === 'unsupported' || permission === 'denied'}
          />
        </div>
        {isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="sound-toggle">Play completion sound</Label>
              <p className="text-sm text-muted-foreground">
                Play a sound when a workspace finishes.
              </p>
            </div>
            <Switch
              id="sound-toggle"
              checked={settings?.playSoundOnComplete ?? true}
              onCheckedChange={(checked) => updateSettings.mutate({ playSoundOnComplete: checked })}
              disabled={updateSettings.isPending}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
