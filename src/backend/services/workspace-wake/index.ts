export type {
  SetWakeScheduleInput,
  WakeOutcome,
  WorkspaceWakeDeliveryBridge,
  WorkspaceWakeScheduleBridge,
} from './service';
export { WorkspaceWakeService } from './service';

import { createLogger } from '@/backend/services/logger.service';
import { WorkspaceWakeService } from './service';

export const workspaceWakeService = new WorkspaceWakeService(createLogger('workspace-wake'));
