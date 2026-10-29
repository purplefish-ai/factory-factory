import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/client/lib/trpc';

type Outputs = inferRouterOutputs<AppRouter>;
export type Agent = Outputs['periodicTask']['get'];
export type AgentListItem = Outputs['periodicTask']['list'][number];
export type AgentRun = Outputs['periodicTask']['listExecutions'][number];
export type AgentCadence = Agent['cadence'];
export type AgentProject = { id: string; name: string; slug: string };
export interface AgentFormValues {
  name: string;
  prompt: string;
  cadence: AgentCadence;
  scheduledTime: string | null;
  timezone: string | null;
}
