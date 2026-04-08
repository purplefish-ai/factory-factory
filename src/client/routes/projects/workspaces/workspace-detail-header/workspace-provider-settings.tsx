import { Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ProviderCliWarning } from '@/client/components/provider-cli-warning';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  EXPLICIT_SESSION_PROVIDER_OPTIONS,
  getWorkspaceDefaultOptionLabel,
  type NewSessionProviderSelection,
  resolveEffectiveSessionProvider,
  resolveProviderSelection,
} from '@/lib/session-provider-selection';
import type { WorkspaceHeaderWorkspace } from './types';

type TriState = 'default' | 'on' | 'off';

function toTriState(value: boolean | null | undefined): TriState {
  if (value === null || value === undefined) {
    return 'default';
  }
  return value ? 'on' : 'off';
}

function fromTriState(value: TriState): boolean | null {
  if (value === 'default') {
    return null;
  }
  return value === 'on';
}

export function WorkspaceProviderSettings({
  workspace,
  workspaceId,
  open,
  onOpenChange,
  showTrigger = true,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [defaultProvider, setDefaultProvider] = useState<NewSessionProviderSelection>(
    resolveProviderSelection(workspace.defaultSessionProvider)
  );
  const [ratchetProvider, setRatchetProvider] = useState<NewSessionProviderSelection>(
    resolveProviderSelection(workspace.ratchetSessionProvider)
  );
  const [ciResponse, setCiResponse] = useState<TriState>(
    toTriState(workspace.ratchetCiResponseEnabled)
  );
  const [mergeConflictResponse, setMergeConflictResponse] = useState<TriState>(
    toTriState(workspace.ratchetMergeConflictResponseEnabled)
  );
  const [reviewResponse, setReviewResponse] = useState<TriState>(
    toTriState(workspace.ratchetReviewResponseEnabled)
  );
  const { data: userSettings } = trpc.userSettings.get.useQuery();
  const utils = trpc.useUtils();

  const invalidateWorkspace = () => {
    utils.workspace.get.invalidate({ id: workspaceId });
    utils.workspace.listWithKanbanState.invalidate({ projectId: workspace.projectId });
    utils.workspace.getProjectSummaryState.invalidate({ projectId: workspace.projectId });
  };

  const updateProviderDefaults = trpc.workspace.updateProviderDefaults.useMutation({
    onSuccess: () => {
      invalidateWorkspace();
      setDialogOpen(false);
    },
  });

  const updateRatchetTriggers = trpc.workspace.updateRatchetTriggers.useMutation({
    onSuccess: () => {
      invalidateWorkspace();
    },
  });

  const isOpenControlled = open !== undefined;
  const dialogOpen = isOpenControlled ? open : uncontrolledOpen;
  const setDialogOpen = (nextOpen: boolean) => {
    if (!isOpenControlled) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  useEffect(() => {
    if (!dialogOpen) {
      return;
    }
    setDefaultProvider(resolveProviderSelection(workspace.defaultSessionProvider));
    setRatchetProvider(resolveProviderSelection(workspace.ratchetSessionProvider));
    setCiResponse(toTriState(workspace.ratchetCiResponseEnabled));
    setMergeConflictResponse(toTriState(workspace.ratchetMergeConflictResponseEnabled));
    setReviewResponse(toTriState(workspace.ratchetReviewResponseEnabled));
  }, [
    dialogOpen,
    workspace.defaultSessionProvider,
    workspace.ratchetSessionProvider,
    workspace.ratchetCiResponseEnabled,
    workspace.ratchetMergeConflictResponseEnabled,
    workspace.ratchetReviewResponseEnabled,
  ]);

  const currentDefaultProvider = resolveProviderSelection(workspace.defaultSessionProvider);
  const currentRatchetProvider = resolveProviderSelection(workspace.ratchetSessionProvider);
  const currentCiResponse = toTriState(workspace.ratchetCiResponseEnabled);
  const currentMergeConflictResponse = toTriState(workspace.ratchetMergeConflictResponseEnabled);
  const currentReviewResponse = toTriState(workspace.ratchetReviewResponseEnabled);
  const isProviderDirty =
    defaultProvider !== currentDefaultProvider || ratchetProvider !== currentRatchetProvider;
  const isTriggerDirty =
    ciResponse !== currentCiResponse ||
    mergeConflictResponse !== currentMergeConflictResponse ||
    reviewResponse !== currentReviewResponse;
  const isDirty = isProviderDirty || isTriggerDirty;
  const userDefaultProvider = userSettings?.defaultSessionProvider;
  const defaultWorkspaceLabel = getWorkspaceDefaultOptionLabel(
    'WORKSPACE_DEFAULT',
    userDefaultProvider
  );
  const ratchetWorkspaceLabel = getWorkspaceDefaultOptionLabel(
    defaultProvider,
    userDefaultProvider
  );

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      {showTrigger && (
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 md:h-8 md:w-8"
                aria-label="Provider settings"
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>Provider settings</TooltipContent>
        </Tooltip>
      )}
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Session Provider Defaults</DialogTitle>
          <DialogDescription>
            Configure workspace defaults and ratchet provider behavior.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="workspace-default-provider">Default Session Provider</Label>
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
          <div className="space-y-2">
            <Label htmlFor="workspace-ratchet-provider">Ratchet Session Provider</Label>
            <Select
              value={ratchetProvider}
              onValueChange={(value) => {
                setRatchetProvider(resolveProviderSelection(value));
              }}
            >
              <SelectTrigger id="workspace-ratchet-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="WORKSPACE_DEFAULT">{ratchetWorkspaceLabel}</SelectItem>
                {EXPLICIT_SESSION_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={`ratchet-${option.value}`} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ProviderCliWarning
              provider={resolveEffectiveSessionProvider(
                ratchetProvider === 'WORKSPACE_DEFAULT' ? defaultProvider : ratchetProvider,
                userDefaultProvider
              )}
            />
          </div>
          {workspace.ratchetEnabled && (
            <>
              <Separator />
              <div className="space-y-3">
                <Label className="text-sm font-medium">Ratchet Triggers</Label>
                <p className="text-xs text-muted-foreground">
                  Override global defaults for which events trigger ratchet dispatches.
                </p>
                <TriggerSelect
                  id="ci-response"
                  label="CI failures"
                  globalDefault={userSettings?.ratchetCiResponseEnabled ?? true}
                  value={ciResponse}
                  onChange={setCiResponse}
                />
                <TriggerSelect
                  id="merge-conflict-response"
                  label="Merge conflicts"
                  globalDefault={userSettings?.ratchetMergeConflictResponseEnabled ?? true}
                  value={mergeConflictResponse}
                  onChange={setMergeConflictResponse}
                />
                <TriggerSelect
                  id="review-response"
                  label="Review comments"
                  globalDefault={userSettings?.ratchetReviewResponseEnabled ?? true}
                  value={reviewResponse}
                  onChange={setReviewResponse}
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (isProviderDirty) {
                updateProviderDefaults.mutate({
                  workspaceId,
                  defaultSessionProvider: defaultProvider,
                  ratchetSessionProvider: ratchetProvider,
                });
              }
              if (isTriggerDirty) {
                updateRatchetTriggers.mutate({
                  workspaceId,
                  ratchetCiResponseEnabled: fromTriState(ciResponse),
                  ratchetMergeConflictResponseEnabled: fromTriState(mergeConflictResponse),
                  ratchetReviewResponseEnabled: fromTriState(reviewResponse),
                });
              }
              if (!isProviderDirty) {
                setDialogOpen(false);
              }
            }}
            disabled={
              !isDirty || updateProviderDefaults.isPending || updateRatchetTriggers.isPending
            }
          >
            {updateProviderDefaults.isPending || updateRatchetTriggers.isPending
              ? 'Saving...'
              : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TriggerSelect({
  id,
  label,
  globalDefault,
  value,
  onChange,
}: {
  id: string;
  label: string;
  globalDefault: boolean;
  value: TriState;
  onChange: (value: TriState) => void;
}) {
  const defaultLabel = `Default (${globalDefault ? 'On' : 'Off'})`;
  return (
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor={`trigger-${id}`} className="text-sm shrink-0">
        {label}
      </Label>
      <Select value={value} onValueChange={(v) => onChange(v as TriState)}>
        <SelectTrigger id={`trigger-${id}`} className="w-[160px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{defaultLabel}</SelectItem>
          <SelectItem value="on">On</SelectItem>
          <SelectItem value="off">Off</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
