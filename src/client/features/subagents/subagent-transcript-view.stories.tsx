import type { Decorator, Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { projectAcpTranscriptUpdates } from '@/client/features/chat';
import {
  SubagentTranscriptContent,
  type SubagentTranscriptState,
} from './subagent-transcript-content';
import type { SubagentSelection } from './types';

const transcriptMessages = projectAcpTranscriptUpdates([
  {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: 'Review the authentication boundary for privilege leaks.' },
  },
  {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'I will trace the request through the authorization layer.' },
  },
  {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'The workspace permission check is applied before the protected resource is loaded.',
    },
  },
]);

function selection(
  status: SubagentSelection['subagent']['status'],
  overrides: Partial<SubagentSelection['subagent']> = {}
): SubagentSelection {
  return {
    parentSessionId: 'session-1',
    parentSessionName: 'Session 1',
    subagent: {
      id: `security-${status}`,
      name: 'Security review',
      status,
      createdAt: '2026-08-08T11:50:00.000Z',
      updatedAt: '2026-08-08T11:59:00.000Z',
      completedAt:
        status === 'completed' || status === 'failed' ? '2026-08-08T11:59:00.000Z' : null,
      latestActivity: status === 'running' ? 'Tracing authorization checks' : null,
      resultPreview: status === 'completed' ? 'No privilege leak found.' : null,
      ...overrides,
    },
  };
}

const readyState: SubagentTranscriptState = {
  kind: 'ready',
  messages: transcriptMessages,
  hasOlder: true,
  loadingOlder: false,
  onLoadOlder: fn(),
};

const desktop: Decorator = (Story) => (
  <div className="h-[640px] w-[900px] max-w-[calc(100vw-2rem)] overflow-hidden border bg-background shadow-sm">
    <Story />
  </div>
);

const narrow: Decorator = (Story) => (
  <div className="h-[640px] w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden border bg-background shadow-sm">
    <Story />
  </div>
);

const meta = {
  title: 'Subagents/SubagentTranscriptView',
  component: SubagentTranscriptContent,
  args: {
    workspaceId: 'workspace-1',
    selection: selection('running'),
    state: readyState,
  },
  parameters: { layout: 'centered' },
} satisfies Meta<typeof SubagentTranscriptContent>;

export default meta;
type Story = StoryObj<typeof meta>;

function story(
  selected: SubagentSelection,
  state: SubagentTranscriptState,
  decorator: Decorator
): Story {
  return { args: { selection: selected, state }, decorators: [decorator] };
}

export const ActiveLiveDesktop = story(selection('running'), readyState, desktop);
export const ActiveLiveNarrow = story(selection('running'), readyState, narrow);

export const CompletedDesktop = story(selection('completed'), readyState, desktop);
export const CompletedNarrow = story(selection('completed'), readyState, narrow);

export const FailedDesktop = story(
  selection('failed', { resultPreview: 'One authorization path returned an invalid response.' }),
  readyState,
  desktop
);
export const FailedNarrow = story(
  selection('failed', { resultPreview: 'One authorization path returned an invalid response.' }),
  readyState,
  narrow
);

export const EmptyDesktop = story(selection('running'), { kind: 'empty' }, desktop);
export const EmptyNarrow = story(selection('running'), { kind: 'empty' }, narrow);

export const LoadingDesktop = story(selection('starting'), { kind: 'loading' }, desktop);
export const LoadingNarrow = story(selection('starting'), { kind: 'loading' }, narrow);

const unavailableState: SubagentTranscriptState = {
  kind: 'unavailable',
  message: 'The provider no longer retains this sub-agent transcript.',
  onRetry: fn(),
};
const unavailableSelection = selection('failed', {
  resultPreview: 'The review stopped after the provider history became unavailable.',
});

export const TranscriptUnavailableDesktop = story(unavailableSelection, unavailableState, desktop);
export const TranscriptUnavailableNarrow = story(unavailableSelection, unavailableState, narrow);
