import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

export function IdeSettingsSection() {
  const { data: settings, isLoading } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();
  const updateSettings = trpc.userSettings.update.useMutation({
    onSuccess: () => {
      toast.success('IDE settings updated');
      utils.userSettings.get.invalidate();
      utils.workspace.getAvailableIdes.invalidate();
    },
    onError: (error) => {
      toast.error(`Failed to update settings: ${error.message}`);
    },
  });

  const testCommand = trpc.userSettings.testCustomCommand.useMutation({
    onSuccess: () => {
      toast.success('Command executed successfully!');
    },
    onError: (error) => {
      toast.error(`Command test failed: ${error.message}`);
    },
  });

  const handleIdeChange = (value: string) => {
    updateSettings.mutate({
      preferredIde: value as 'cursor' | 'vscode' | 'custom',
      ...(value === 'custom' && {
        customIdeCommand: settings?.customIdeCommand || null,
      }),
    });
  };

  const [localCustomCommand, setLocalCustomCommand] = useState(settings?.customIdeCommand || '');

  // Sync local state when settings change externally
  useEffect(() => {
    setLocalCustomCommand(settings?.customIdeCommand || '');
  }, [settings?.customIdeCommand]);

  const saveCustomCommand = (value: string) => {
    updateSettings.mutate({
      preferredIde: 'custom',
      customIdeCommand: value || null,
    });
  };

  const handleTestCommand = () => {
    if (!localCustomCommand) {
      toast.error('Please enter a custom command first');
      return;
    }
    testCommand.mutate({ customCommand: localCustomCommand });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>IDE Settings</CardTitle>
          <CardDescription>Configure your preferred IDE for opening workspaces</CardDescription>
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
        <CardTitle>IDE Settings</CardTitle>
        <CardDescription>Configure your preferred IDE for opening workspaces</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="ide-select">Preferred IDE</Label>
          <Select
            value={settings?.preferredIde ?? 'cursor'}
            onValueChange={handleIdeChange}
            disabled={updateSettings.isPending}
          >
            <SelectTrigger id="ide-select">
              <SelectValue placeholder="Select an IDE" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cursor">Cursor</SelectItem>
              <SelectItem value="vscode">VS Code</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {settings?.preferredIde === 'custom' && (
          <div className="space-y-2">
            <Label htmlFor="custom-command">Custom Command</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="custom-command"
                value={localCustomCommand}
                onChange={(e) => setLocalCustomCommand(e.target.value)}
                onBlur={() => saveCustomCommand(localCustomCommand)}
                placeholder="code-insiders {workspace}"
                className="font-mono text-sm flex-1"
                disabled={updateSettings.isPending}
              />
              <Button
                variant="outline"
                onClick={handleTestCommand}
                disabled={testCommand.isPending || !localCustomCommand}
              >
                {testCommand.isPending ? 'Testing...' : 'Test'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Use <code className="bg-muted px-1 py-0.5 rounded">{'{workspace}'}</code> as a
              placeholder for the workspace path. Example:{' '}
              <code className="bg-muted px-1 py-0.5 rounded">code-insiders {'{workspace}'}</code>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
