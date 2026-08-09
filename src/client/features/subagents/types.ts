import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/client/lib/trpc';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type SubagentListResult = RouterOutputs['session']['listSubagents'];
type SupportedSubagentListResult = Extract<SubagentListResult, { supported: true }>;

export type SubagentListItem = SupportedSubagentListResult['subagents'][number];

export interface SubagentSelection {
  parentSessionId: string;
  subagent: SubagentListItem;
}
