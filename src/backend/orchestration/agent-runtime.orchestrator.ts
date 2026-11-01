import { AgentSourcePollService } from '@/backend/services/agent-definition';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { classifyGitHubCLIError, type githubCLIService } from '@/backend/services/github';
import { jobRunner } from '@/backend/services/job-runner.service';

const JOB = 'agent-source-poll';
type AgentRuntimeServices = {
  githubCLIService: Pick<
    typeof githubCLIService,
    'getAgentRepositoryIdentity' | 'listAgentIssueEvents'
  >;
  configService: { getAgentRuntimeLimits(): { githubPagesPerCycle: number } };
};

/** Composition owns provider wiring and intake lifecycle; the capsule owns persistence. */
export function createAgentRuntime(getServices: () => AgentRuntimeServices) {
  const poller = new AgentSourcePollService(
    {
      getRepositoryIdentity: (repository, signal) =>
        getServices().githubCLIService.getAgentRepositoryIdentity(repository, signal),
      listIssueEvents: (input, signal) =>
        getServices().githubCLIService.listAgentIssueEvents(input, signal),
      classifyError: classifyGitHubCLIError,
    },
    () => getServices().configService.getAgentRuntimeLimits().githubPagesPerCycle
  );
  return createAgentRuntimeLifecycle(poller);
}

export function createAgentRuntimeLifecycle(poller: Pick<AgentSourcePollService, 'pollCycle'>) {
  jobRunner.register({
    name: JOB,
    intervalMs: SERVICE_INTERVAL_MS.agentSourcePoll,
    runImmediately: true,
    run: (signal) => poller.pollCycle(signal),
  });
  return { start: () => jobRunner.start(JOB), stop: () => jobRunner.stop(JOB) };
}
