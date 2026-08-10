import { vi } from 'vitest';
import type { SubagentSelection } from '@/client/features/subagents';

export function subagentTabId(selection: SubagentSelection): string {
  return `subagent-${selection.parentSessionId}-${selection.subagent.id}`;
}

export function seedSubagentTab(
  workspaceId: string,
  selection: SubagentSelection,
  activeTabId = subagentTabId(selection)
) {
  localStorage.setItem(
    `workspace-panel-tabs-${workspaceId}`,
    JSON.stringify([
      { id: 'chat', type: 'chat', label: 'Chat' },
      {
        id: subagentTabId(selection),
        type: 'subagent',
        label: selection.subagent.name,
        subagentSelection: selection,
      },
    ])
  );
  localStorage.setItem(`workspace-panel-active-tab-${workspaceId}`, activeTabId);
}

export function createLoadingSubagentTranscriptQuery() {
  return {
    data: undefined,
    error: null,
    isLoading: true,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(() => Promise.resolve()),
    refetch: vi.fn(() => Promise.resolve()),
  };
}

export function setupSubagentTabTestEnvironment() {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

export function cleanupSubagentTabTestEnvironment() {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
}
