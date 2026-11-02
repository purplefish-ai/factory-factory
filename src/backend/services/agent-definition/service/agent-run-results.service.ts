import { agentRunResultsAccessor } from '@/backend/services/agent-definition/resources/agent-run-results.accessor';

export const eventRunResults = {
  captureWorkspace(...input: Parameters<typeof agentRunResultsAccessor.captureWorkspace>) {
    return agentRunResultsAccessor.captureWorkspace(...input);
  },
};
