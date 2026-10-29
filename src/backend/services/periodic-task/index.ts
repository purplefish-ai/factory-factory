export {
  PeriodicTaskService,
  type PeriodicTaskWorkspaceBridge,
  type PeriodicTaskWorkspaceStatusBridge,
  type PeriodicTaskTimerEvent,
} from './service';

import { createLogger } from '@/backend/services/logger.service';
import { PeriodicTaskService } from './service';

export const periodicTaskService = new PeriodicTaskService(createLogger('periodic-task'));
