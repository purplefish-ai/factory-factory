export {
  PeriodicTaskService,
  type PeriodicTaskWorkspaceBridge,
  type PeriodicTaskWorkspaceStatusBridge,
} from './service';

import { createLogger } from '@/backend/services/logger.service';
import { PeriodicTaskService } from './service';

export const periodicTaskService = new PeriodicTaskService(createLogger('periodic-task'));
