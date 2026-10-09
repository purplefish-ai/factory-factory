import { CaretDownIcon } from '@phosphor-icons/react';
import { PRMonitoringMenuItems, RatchetToggleButton } from '@/client/features/workspace';
import { useToggleRatcheting } from '@/client/hooks/use-toggle-ratcheting';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PRDeliveryMode } from '@/shared/pr-monitoring';
import type { WorkspaceHeaderWorkspace } from './types';

export function RatchetingToggle({
  workspace,
  workspaceId,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
}) {
  const toggleRatcheting = useToggleRatcheting(workspace.projectId);
  const mode = workspace.prMonitoring?.deliveryMode ?? PRDeliveryMode.MAIN;
  return (
    <>
      {toggleRatcheting.recipientPicker}
      <RatchetToggleButton
        enabled={workspace.ratchetEnabled ?? false}
        state={workspace.ratchetState}
        animated={workspace.ratchetButtonAnimated ?? false}
        disabled={toggleRatcheting.isPending}
        onToggle={(enabled) => toggleRatcheting.mutate({ workspaceId, enabled })}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1"
            aria-label={`PR update destination: ${mode === PRDeliveryMode.MAIN ? 'Main conversation' : 'Dedicated conversation per PR'}`}
          >
            <CaretDownIcon className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <RatchetingMenuItems
            workspace={workspace}
            workspaceId={workspaceId}
            toggleRatcheting={toggleRatcheting}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
export function RatchetingMenuItems({
  workspace,
  workspaceId,
  toggleRatcheting,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
  toggleRatcheting: ReturnType<typeof useToggleRatcheting>;
}) {
  const mode = workspace.prMonitoring?.deliveryMode ?? PRDeliveryMode.MAIN;
  const enabled = workspace.ratchetEnabled ?? false;
  return (
    <PRMonitoringMenuItems
      enabled={enabled}
      deliveryMode={mode}
      pending={toggleRatcheting.isPending}
      pauseReason={workspace.prMonitoring?.pauseReason}
      onResume={() =>
        toggleRatcheting.mutate({
          workspaceId,
          enabled: true,
          resume: true,
          deliveryMode: mode,
          expectedBindingRevision: workspace.prMonitoring?.bindingRevision,
        })
      }
      onToggle={(nextEnabled) => toggleRatcheting.mutate({ workspaceId, enabled: nextEnabled })}
      onDeliveryMode={(deliveryMode) =>
        toggleRatcheting.mutate({
          workspaceId,
          enabled,
          deliveryMode,
          expectedBindingRevision: workspace.prMonitoring?.bindingRevision,
        })
      }
      onChangeRecipient={() =>
        toggleRatcheting.mutate({
          workspaceId,
          enabled: true,
          deliveryMode: PRDeliveryMode.MAIN,
          recipientSessionId: null,
        })
      }
    />
  );
}
