import { toast } from 'sonner';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

export function ChildWorkspaceSettingsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      runInBackground(utils.userSettings.get.invalidate(), 'Could not refresh data');
    },
    onError: (error) => {
      toast.error(`Failed to update settings: ${error.message}`);
    },
  });

  const handleToggleChildren = (checked: boolean) => {
    updateSettings.mutate({ childWorkspacesEnabled: checked });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Child Workspaces</CardTitle>
          <CardDescription>Delegate work to separate child workspaces</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Child Workspaces</CardTitle>
        <CardDescription>Delegate work to separate child workspaces</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="child-workspaces-toggle">Enable child workspaces</Label>
            <p className="text-sm text-muted-foreground">
              Show child workspace controls and let agents delegate work. Existing workspaces are
              preserved when disabled.
            </p>
          </div>
          <Switch
            id="child-workspaces-toggle"
            checked={settings?.childWorkspacesEnabled ?? true}
            onCheckedChange={handleToggleChildren}
            disabled={updateSettings.isPending}
          />
        </div>
      </CardContent>
    </Card>
  );
}
