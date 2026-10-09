import type { UseToggleRatchetingReturn } from '@/client/hooks/use-toggle-ratcheting';
import { PRDeliveryMode, type PRMonitoringProjection } from '@/shared/pr-monitoring';
import type { PRMonitoringMenuProps } from './pr-monitoring-menu-items';

type MonitoringMenuState = Pick<PRMonitoringProjection, 'enabled'> &
  Partial<Pick<PRMonitoringProjection, 'deliveryMode' | 'bindingRevision' | 'pauseReason'>>;

export function createPRMonitoringMenuProps(
  workspaceId: string,
  monitoring: MonitoringMenuState,
  toggle: Pick<UseToggleRatchetingReturn, 'mutate' | 'isPending'>
): PRMonitoringMenuProps {
  const deliveryMode = monitoring.deliveryMode ?? PRDeliveryMode.MAIN;
  return {
    enabled: monitoring.enabled,
    deliveryMode,
    pending: toggle.isPending,
    pauseReason: monitoring.pauseReason,
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
      }),
  };
}
