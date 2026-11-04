import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { AgentDetail } from './agent-detail';
import { AgentForm } from './agent-form';
import { AgentRunHistory } from './agent-run-history';
import { AgentsDashboardShell } from './agents-dashboard-shell';
import {
  EventDashboardStory,
  eventStoryAgent,
  type EventStoryState,
} from './event-dashboard-story';
import type { Agent } from './types';

const project = { id: 'factory', slug: 'factory-factory', name: 'Factory Factory' };
const agent: Agent = {
  executions: [],
  id: 'review',
  projectId: project.id,
  name: 'Review recent changes',
  prompt:
    'Review the changes merged in the last day. Look for regressions, missing edge cases and opportunities to simplify.\n\nOpen a focused pull request for any clear fixes. Explain what you changed and how you verified it.',
  cadence: 'DAILY',
  scheduledTime: '09:00',
  timezone: 'America/New_York',
  scheduledDayOfMonth: null,
  isEnabled: true,
  nextRunAt: new Date('2026-10-30T13:00:00Z'),
  lastRunAt: new Date('2026-10-29T13:00:00Z'),
  createdAt: new Date('2026-10-01T13:00:00Z'),
  updatedAt: new Date('2026-10-29T13:00:00Z'),
};
const agents = [
  agent,
  {
    ...agent,
    id: 'dependencies',
    name: 'Keep dependencies current',
    prompt: 'Check for safe dependency updates and open a focused pull request.',
    cadence: 'WEEKLY' as const,
    isEnabled: false,
  },
  {
    ...agent,
    id: 'tests',
    name: 'Find missing test coverage',
    prompt: 'Add meaningful regression tests around recently changed behavior.',
    scheduledTime: null,
    timezone: null,
  },
];

type StoryMode = 'populated' | 'empty' | 'error' | 'loading' | 'create' | 'edit' | EventStoryState;
function StoryContent({
  mode,
  setMode,
  enabled,
  onToggle,
}: {
  mode: StoryMode;
  setMode: (mode: StoryMode) => void;
  enabled: boolean;
  onToggle: () => void;
}) {
  return mode === 'create' || mode === 'edit' ? (
    <>
      <div>
        <h2 className="text-xl font-semibold">{mode === 'edit' ? 'Edit agent' : 'Create agent'}</h2>
      </div>
      <AgentForm
        initialValues={mode === 'edit' ? agent : undefined}
        onSave={() => {
          setMode('populated');
          return Promise.resolve();
        }}
        onCancel={() => setMode('populated')}
      />
    </>
  ) : mode === 'loading' ? (
    <p role="status" className="text-sm text-muted-foreground">
      Loading agent…
    </p>
  ) : mode === 'error' ? (
    <p role="alert" className="text-sm text-destructive">
      Could not load agent. Retry to reconnect.
    </p>
  ) : mode === 'empty' ? (
    <div className="py-16 text-center">
      <h2 className="text-lg font-semibold">Give recurring work an agent</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Create an agent with instructions and a schedule to get started.
      </p>
    </div>
  ) : (
    <AgentDetail
      agent={{ ...agent, isEnabled: enabled }}
      onEdit={() => setMode('edit')}
      onToggle={onToggle}
      onDelete={() => setMode('empty')}
    >
      <AgentRunHistory
        projectSlug={project.slug}
        runs={[
          {
            id: 'today',
            periodicTaskId: agent.id,
            launchSnapshot: null,
            workspaceId: 'run-today',
            status: 'RUNNING',
            startedAt: new Date('2026-10-29T13:00:00Z'),
            completedAt: null,
            prUrl: null,
            prNumber: null,
            errorMessage: null,
          },
          {
            id: 'yesterday',
            periodicTaskId: agent.id,
            launchSnapshot: null,
            workspaceId: 'run-yesterday',
            status: 'PR_CREATED',
            startedAt: new Date('2026-10-28T13:00:00Z'),
            completedAt: new Date('2026-10-28T13:10:00Z'),
            prUrl: 'https://github.com/example/repo/pull/42',
            prNumber: 42,
            errorMessage: null,
          },
          {
            id: 'nothing-to-do',
            periodicTaskId: agent.id,
            launchSnapshot: null,
            workspaceId: 'run-nothing-to-do',
            status: 'COMPLETED',
            startedAt: new Date('2026-10-27T18:00:00Z'),
            completedAt: new Date('2026-10-27T18:06:00Z'),
            prUrl: null,
            prNumber: null,
            errorMessage: null,
          },
          {
            id: 'failed',
            periodicTaskId: agent.id,
            launchSnapshot: null,
            workspaceId: null,
            status: 'FAILED',
            startedAt: new Date('2026-10-27T13:00:00Z'),
            completedAt: new Date('2026-10-27T13:01:00Z'),
            prUrl: null,
            prNumber: null,
            errorMessage:
              'The provider could not start a session. Check authentication and try again on the next run.',
          },
        ]}
      />
    </AgentDetail>
  );
}

function DashboardSession({ state = 'populated' }: { state?: StoryMode }) {
  const [mode, setMode] = useState(state);
  const [enabled, setEnabled] = useState(true);
  const eventState = mode.startsWith('event') ? (mode as EventStoryState) : null;
  return (
    <div className="h-dvh bg-background text-foreground">
      <AgentsDashboardShell
        projectSlug={project.slug}
        agents={
          mode === 'empty'
            ? []
            : mode === 'loading' || mode === 'error'
              ? undefined
              : [...agents, { ...eventStoryAgent(eventState ?? 'event'), kind: 'event' as const }]
        }
        selectedKind={eventState ? 'event' : 'scheduled'}
        selectedAgentId={mode === 'create' ? undefined : eventState ? 'event-agent' : agent.id}
        isLoading={mode === 'loading'}
        error={mode === 'error' ? 'Could not load agents: Connection unavailable.' : undefined}
        onRetry={() => setMode('populated')}
        onCreate={() => setMode('create')}
      >
        {eventState ? (
          <EventDashboardStory key={eventState} state={eventState} />
        ) : (
          <StoryContent
            mode={mode}
            setMode={setMode}
            enabled={enabled}
            onToggle={() => setEnabled(!enabled)}
          />
        )}
      </AgentsDashboardShell>
    </div>
  );
}
function DashboardStory({
  state = 'populated',
  contentWidth,
}: {
  state?: StoryMode;
  contentWidth?: number;
}) {
  return (
    <div style={{ width: contentWidth, maxWidth: '100%' }}>
      <DashboardSession key={state} state={state} />
    </div>
  );
}
const meta = {
  title: 'Agents/AgentsDashboard',
  component: DashboardStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DashboardStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = {};
export const Empty: Story = { args: { state: 'empty' } };
export const EmptyDark: Story = { args: { state: 'empty' }, globals: { theme: 'dark' } };
export const Loading: Story = { args: { state: 'loading' } };
export const RequestFailure: Story = { args: { state: 'error' } };
export const Create: Story = { args: { state: 'create' } };
export const Edit: Story = { args: { state: 'edit' } };

// A wide browser can still leave a narrow editor beside the workspace sidebar.
export const ConstrainedCreate: Story = { args: { state: 'create', contentWidth: 458 } };
export const ConstrainedEdit: Story = { args: { state: 'edit', contentWidth: 640 } };
export const ConstrainedDetail: Story = { args: { state: 'populated', contentWidth: 416 } };

export const MixedList: Story = { args: { state: 'populated' } };
export const SavedEvent: Story = { args: { state: 'event' } };
export const SavedEventEdit: Story = { args: { state: 'event-edit' } };
export const UnknownMembership: Story = { args: { state: 'event-unknown' } };
export const CompleteReplacement: Story = {
  args: { state: 'event-replacement', contentWidth: 416 },
};
export const NullStoredConfiguration: Story = { args: { state: 'event-null' } };
export const SourceError: Story = { args: { state: 'event-health-error' } };
export const SourceCatchingUp: Story = { args: { state: 'event-health-catching-up' } };
export const UnsupportedNativePreview: Story = { args: { state: 'event-preview-unsupported' } };
export const UnavailableNativePreview: Story = { args: { state: 'event-preview-unavailable' } };
export const SavedConflict: Story = { args: { state: 'event-conflict' } };
export const ConstrainedEventEdit: Story = { args: { state: 'event-edit', contentWidth: 458 } };
export const ConstrainedEventDetail: Story = { args: { state: 'event', contentWidth: 640 } };
