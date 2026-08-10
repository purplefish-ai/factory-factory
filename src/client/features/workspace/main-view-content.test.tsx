// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentSelection } from '@/client/features/subagents';
import {
  cleanupSubagentTabTestEnvironment,
  createLoadingSubagentTranscriptQuery,
  seedSubagentTab,
  setupSubagentTabTestEnvironment,
} from '@/test-utils/subagent-tabs';
import { MainViewContent } from './main-view-content';
import { WorkspacePanelProvider } from './workspace-panel-context';

const mocks = vi.hoisted(() => ({
  readSubagentTranscript: vi.fn(),
}));

vi.mock('@/client/lib/trpc', () => ({
  trpc: {
    session: {
      listSubagents: {
        useQuery: () => ({ data: undefined, refetch: vi.fn(() => Promise.resolve()) }),
      },
      readSubagentTranscript: {
        useInfiniteQuery: mocks.readSubagentTranscript,
      },
    },
  },
}));

const WORKSPACE_ID = 'workspace-content-subagent';
const runningSelection: SubagentSelection = {
  parentSessionId: 'session-1',
  parentSessionName: 'Chat 1',
  subagent: {
    id: 'child-1',
    name: 'Security review',
    status: 'running',
    createdAt: '2026-08-10T10:00:00.000Z',
    updatedAt: '2026-08-10T10:01:00.000Z',
    completedAt: null,
    latestActivity: 'Inspecting auth',
    resultPreview: null,
  },
};

async function renderContent() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => {
    root.render(
      <WorkspacePanelProvider workspaceId={WORKSPACE_ID}>
        <MainViewContent workspaceId={WORKSPACE_ID}>
          <div data-testid="chat-content">Chat content</div>
        </MainViewContent>
      </WorkspacePanelProvider>
    );
  });
  return { container, root };
}

beforeEach(() => {
  setupSubagentTabTestEnvironment();
  mocks.readSubagentTranscript.mockReturnValue(createLoadingSubagentTranscriptQuery());
});

afterEach(() => {
  cleanupSubagentTabTestEnvironment();
  vi.clearAllMocks();
});

describe('MainViewContent sub-agent tabs', () => {
  it('renders a persisted active sub-agent tab while keeping chat mounted and hidden', async () => {
    seedSubagentTab(WORKSPACE_ID, runningSelection);
    const { container, root } = await renderContent();

    await vi.waitFor(() => expect(container.textContent).toContain('Loading transcript…'));
    const chat = container.querySelector('[data-testid="chat-content"]');
    expect(chat).not.toBeNull();
    expect(chat?.parentElement?.classList.contains('hidden')).toBe(true);

    await act(() => root.unmount());
  });
});
