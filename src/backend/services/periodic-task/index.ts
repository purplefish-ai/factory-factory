export {
  PeriodicTaskService,
  type PeriodicTaskTimerDispatchBridge,
  type PeriodicTaskWorkspaceStatusBridge,
} from './service/periodic-task.service';
export type { PeriodicTaskTimerEvent } from './service/periodic-task-timer-event';

import { createLogger } from '@/backend/services/logger.service';
import { PeriodicTaskService } from './service/periodic-task.service';

export const periodicTaskService = new PeriodicTaskService(createLogger('periodic-task'));

export {
  exportPeriodicConfigRecovery,
  exportPeriodicHistoryRecovery,
  planPeriodicHistoryRecovery,
  restorePeriodicHistoryRecovery,
  restorePeriodicConfigRecovery,
  readPeriodicConfigRecoveryIds,
} from './service/periodic-recovery';
