import { AgentSourcePollService } from '@/backend/services/agent-definition';
import { SERVICE_INTERVAL_MS } from '@/backend/services/constants';
import { classifyGitHubCLIError, githubCLIService } from '@/backend/services/github';
import { jobRunner } from '@/backend/services/job-runner.service';

const JOB = 'agent-source-poll';

/** Composition owns provider wiring and intake lifecycle; the capsule owns persistence. */
export function createAgentRuntime(
  poller: Pick<AgentSourcePollService, 'pollCycle'> = new AgentSourcePollService({
    getRepositoryIdentity: (repository, signal) =>
      githubCLIService.getAgentRepositoryIdentity(repository, signal),
    listIssueEvents: (input, signal) => githubCLIService.listAgentIssueEvents(input, signal),
    classifyError: classifyGitHubCLIError,
  })
) {
  jobRunner.register({
    name: JOB,
    intervalMs: SERVICE_INTERVAL_MS.agentSourcePoll,
    runImmediately: true,
    run: (signal) => poller.pollCycle(signal),
  });
  return { start: () => jobRunner.start(JOB), stop: () => jobRunner.stop(JOB) };
}
