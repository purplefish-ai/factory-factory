// Domain: workspace-wake
// Public API for the workspace-wake domain module.
// Consumers should import from '@/backend/services/workspace-wake' only.

export type {
  SetWakeScheduleInput,
  WakeOutcome,
  WorkspaceWakeDeliveryBridge,
  WorkspaceWakeScheduleBridge,
} from './workspace-wake.service';
export { WorkspaceWakeService } from './workspace-wake.service';
