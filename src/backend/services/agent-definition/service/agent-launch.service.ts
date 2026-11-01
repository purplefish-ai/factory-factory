import { agentLaunchRecoveryAccessor } from '@/backend/services/agent-definition/resources/agent-launch-recovery.accessor';
import { agentLaunchAccessor } from '@/backend/services/agent-definition/resources/agent-launch.accessor';

export const eventRunLaunch = { ...agentLaunchAccessor, ...agentLaunchRecoveryAccessor };
