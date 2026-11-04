import { memo, useEffect, useState } from 'react';
import { ProviderCliWarning } from '@/client/components/provider-cli-warning';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  EXPLICIT_SESSION_PROVIDER_OPTIONS,
  getWorkspaceDefaultOptionLabel,
  type NewSessionProviderSelection,
  resolveEffectiveSessionProvider,
  resolveProviderSelection,
} from '@/lib/session-provider-selection';
import type { WorkspaceHeaderWorkspace } from './types';

export const WorkspaceProviderSettings = memo(function WorkspaceProviderSettings({
  workspace,
  workspaceId,
  open: dialogOpen,
  onOpenChange: setDialogOpen,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [defaultProvider, setDefaultProvider] = useState<NewSessionProviderSelection>(
    resolveProviderSelection(workspace.defaultSessionProvider)
  );
  const { data: userSettings } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();

  const updateProviderDefaults = trpc.workspace.updateProviderDefaults.useMutation({
    meta: { errorToast: "Couldn't save provider settings." },
    onSuccess: () => {
      runInBackground(
        utils.workspace.get.invalidate({ id: workspaceId }),
        "Couldn't refresh data."
      );
      runInBackground(
        utils.workspace.listForProject.invalidate({ projectId: workspace.projectId }),
        "Couldn't refresh data."
      );
      setDialogOpen(false);
    },
  });

  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    setDefaultProvider(resolveProviderSelection(workspace.defaultSessionProvider));
  }, [dialogOpen, workspace.defaultSessionProvider]);

  const currentDefaultProvider = resolveProviderSelection(workspace.defaultSessionProvider);
  const isDirty = defaultProvider !== currentDefaultProvider;
  const userDefaultProvider = userSettings?.defaultSessionProvider;
  const defaultWorkspaceLabel = getWorkspaceDefaultOptionLabel(
    'WORKSPACE_DEFAULT',
    userDefaultProvider
  );

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Session provider defaults</DialogTitle>
          <DialogDescription>Configure the default provider for new sessions.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="workspace-default-provider">Default session provider</Label>
            <Select
              value={defaultProvider}
              onValueChange={(value) => {
                setDefaultProvider(resolveProviderSelection(value));
              }}
            >
              <SelectTrigger id="workspace-default-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="WORKSPACE_DEFAULT">{defaultWorkspaceLabel}</SelectItem>
                {EXPLICIT_SESSION_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={`default-${option.value}`} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ProviderCliWarning
              provider={resolveEffectiveSessionProvider(defaultProvider, userDefaultProvider)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              updateProviderDefaults.mutate({
                workspaceId,
                defaultSessionProvider: defaultProvider,
              });
            }}
            disabled={!isDirty || updateProviderDefaults.isPending}
          >
            {updateProviderDefaults.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
