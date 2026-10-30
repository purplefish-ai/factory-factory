// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatTranscriptProps, TranscriptPosition } from '@/client/features/chat';
import type { SubagentSelection } from '@/client/features/subagents';
import {
  cleanupSubagentTabTestEnvironment,
  createLoadingSubagentTranscriptQuery,
  seedSubagentTab,
  setupSubagentTabTestEnvironment,
  subagentTabId,
} from '@/test-utils/subagent-tabs';
import { MainViewContent } from './main-view-content';
import { useWorkspacePanel, WorkspacePanelProvider } from './workspace-panel-context';

const mocks = vi.hoisted(() => ({
  readSubagentTranscript: vi.fn(),
  transcript: vi.fn(),
}));

vi.mock('@/client/features/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/client/features/chat')>()),
  ChatTranscript: (props: ChatTranscriptProps) => {
    mocks.transcript(props);
    return <div>Transcript</div>;
  },
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

let panel: ReturnType<typeof useWorkspacePanel>;
function PanelProbe() {
  panel = useWorkspacePanel();
  return null;
}

async function renderContent() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => {
    root.render(
      <WorkspacePanelProvider workspaceId={WORKSPACE_ID}>
        <PanelProbe />
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

  it('restores separate sub-agent reading positions after chat switches, A/B switches, and remounts', async () => {
    mocks.readSubagentTranscript.mockReturnValue({
      ...createLoadingSubagentTranscriptQuery(),
      isLoading: false,
      data: {
        pages: [
          {
            updates: [
              { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Review' } },
            ],
            nextCursor: null,
          },
        ],
      },
    });
    seedSubagentTab(WORKSPACE_ID, runningSelection);
    let view = await renderContent();
    const scroll = () => {
      const props = mocks.transcript.mock.lastCall?.[0] as ChatTranscriptProps | undefined;
      if (!props) {
        throw new Error('Expected a ready transcript');
      }
      return props.scroll;
    };
    const a: TranscriptPosition = {
      intent: 'reading',
      top: 321,
      left: 0,
      anchor: { key: 'message-a', offset: 12 },
    };
    const b: TranscriptPosition = { intent: 'following', top: 900, left: 0 };
    expect(scroll().initialIntent).toBe('reading');
    expect(scroll().initialPosition).toBeNull();
    const oldA = scroll().onPositionChange;
    expect(oldA).toBeTypeOf('function');
    act(() => oldA?.(a));
    await act(() => panel.selectTab('chat'));
    act(() => oldA?.(b));
    await act(() => panel.selectTab(subagentTabId(runningSelection)));
    expect(scroll().initialPosition).toEqual(a);

    const other = {
      ...runningSelection,
      subagent: { ...runningSelection.subagent, id: 'child-2' },
    };
    await act(() => panel.openSubagentTab(other));
    expect(scroll().initialPosition).toBeNull();
    act(() => scroll().onPositionChange?.(b));
    await act(() => panel.selectTab(subagentTabId(runningSelection)));
    act(() => oldA?.(b));
    expect(scroll().initialPosition).toEqual(a);
    await act(() => view.root.unmount());
    view = await renderContent();
    expect(scroll().initialPosition).toEqual(a);
    await act(() => panel.selectTab(subagentTabId(other)));
    expect(scroll().initialPosition).toEqual(b);
    const oldB = scroll().onPositionChange;
    await act(() => panel.closeTab(subagentTabId(other)));
    act(() => oldB?.(b));
    await act(() => panel.openSubagentTab(other));
    expect(scroll().initialPosition).toBeNull();
    await act(() => view.root.unmount());
  });
});
