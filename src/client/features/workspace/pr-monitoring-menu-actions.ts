import type { UseToggleRatchetingReturn } from '@/client/hooks/use-toggle-ratcheting';
import { PRDeliveryMode, type PRMonitoringProjection } from '@/shared/pr-monitoring';
import type { PRMonitoringMenuProps } from './pr-monitoring-menu-items';

type MonitoringMenuState = Pick<PRMonitoringProjection, 'enabled'> &
  Partial<Pick<PRMonitoringProjection, 'deliveryMode' | 'bindingRevision' | 'pauseReason'>>;

export function createPRMonitoringMenuProps(
  workspaceId: string,
  monitoring: MonitoringMenuState,
  toggle: Pick<UseToggleRatchetingReturn, 'mutate' | 'pendingWorkspaceIds'>,
  onDiscardBlocked?: () => void
): PRMonitoringMenuProps {
  const deliveryMode = monitoring.deliveryMode ?? PRDeliveryMode.MAIN;
  return {
    enabled: monitoring.enabled,
    deliveryMode,
    // Toggles from any surface (card wrench, header, menu) mark this workspace.
    pending: toggle.pendingWorkspaceIds.includes(workspaceId),
    pauseReason: monitoring.pauseReason,
    ...(onDiscardBlocked && { onDiscardBlocked }),
    onToggle: (enabled) => toggle.mutate({ workspaceId, enabled }),
    onDeliveryMode: (mode) =>
      toggle.mutate({
        workspaceId,
        enabled: monitoring.enabled,
        deliveryMode: mode,
        expectedBindingRevision: monitoring.bindingRevision,
      }),
    onResume: () =>
      toggle.mutate({
        workspaceId,
        enabled: true,
        resume: true,
        deliveryMode,
        expectedBindingRevision: monitoring.bindingRevision,
      }),
    onChangeRecipient: () =>
      toggle.mutate({
        workspaceId,
        enabled: true,
        deliveryMode: PRDeliveryMode.MAIN,
        recipientSessionId: null,
        expectedBindingRevision: monitoring.bindingRevision,
      }),
  };
}
