import {
  ingestEvent,
  SlackEventSource,
  type slackConnectionService,
} from '@/backend/services/agent-definition';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { jobRunner } from '@/backend/services/job-runner.service';
import { createSlackSocket } from './slack-socket';

const JOB = 'agent-slack-intake';

type SlackIntakeServices = {
  slackConnectionService: Pick<typeof slackConnectionService, 'getAppCredentials'>;
  configService: { getAgentRuntimeLimits(): { slackIntakeEnabled: boolean } };
};

/**
 * Composition for the Slack Socket Mode listener. The capsule adapter owns its
 * sockets and their SDK timers; this job reconciles which connections should be
 * open, including reconnecting after Slack closes a socket.
 */
export function createSlackIntake(
  getServices: () => SlackIntakeServices,
  createSocket: typeof createSlackSocket = createSlackSocket
) {
  const source = new SlackEventSource({
    createSocket: (appToken, handlers) => createSocket(appToken, handlers),
    getAppCredentials: (connectionId) =>
      getServices().slackConnectionService.getAppCredentials(connectionId),
    isEnabled: () => getServices().configService.getAgentRuntimeLimits().slackIntakeEnabled,
    ingestEvent,
  });
  jobRunner.register({
    name: JOB,
    intervalMs: SERVICE_INTERVAL_MS.agentSlackIntake,
    runImmediately: true,
    run: (signal) => source.reconcileConnections(signal),
  });
  return {
    start: () => {
      source.start();
      jobRunner.start(JOB);
    },
    /** Closes sockets and drains envelopes in flight before the database closes. */
    stop: async () => {
      await Promise.all([source.stop(), jobRunner.stop(JOB)]);
    },
  };
}
