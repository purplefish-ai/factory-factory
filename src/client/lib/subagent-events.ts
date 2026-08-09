import type { SubagentsChangedParams } from '@/shared/acp-protocol/subagents';

export const SUBAGENTS_CHANGED_BROWSER_EVENT = 'factoryfactory:subagents-changed';

export type SubagentChangeDetail = SubagentsChangedParams;

export function dispatchSubagentChange(detail: SubagentChangeDetail): void {
  window.dispatchEvent(
    new CustomEvent<SubagentChangeDetail>(SUBAGENTS_CHANGED_BROWSER_EVENT, { detail })
  );
}

export function subscribeToSubagentChanges(
  listener: (detail: SubagentChangeDetail) => void
): () => void {
  const handleEvent = (event: Event) => {
    listener((event as CustomEvent<SubagentChangeDetail>).detail);
  };

  window.addEventListener(SUBAGENTS_CHANGED_BROWSER_EVENT, handleEvent);
  return () => window.removeEventListener(SUBAGENTS_CHANGED_BROWSER_EVENT, handleEvent);
}
