import type { SubagentListItem } from './types';

export function isActiveSubagent(subagent: SubagentListItem): boolean {
  return (
    subagent.status === 'starting' || subagent.status === 'running' || subagent.status === 'waiting'
  );
}
