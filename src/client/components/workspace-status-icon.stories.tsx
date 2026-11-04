import type { Meta, StoryObj } from '@storybook/react';
import { WorkspaceStatusIcon } from './workspace-status-icon';

const STATES = [
  { label: 'Idle', props: {} },
  { label: 'Agent working', props: { isWorking: true } },
  { label: 'Needs permission', props: { pendingRequestType: 'permission_request' } },
  { label: 'Needs plan approval', props: { pendingRequestType: 'plan_approval' } },
  { label: 'Needs your answer', props: { pendingRequestType: 'user_question' } },
  { label: 'Session error', props: { sessionRuntimeErrorMessage: 'Agent exited' } },
] as const;

function AllStates() {
  return (
    <div className="space-y-2 bg-background p-4 text-sm text-foreground">
      {STATES.map((state) => (
        <div key={state.label} className="flex items-center gap-2">
          <span className="flex w-3.5 justify-center">
            <WorkspaceStatusIcon {...state.props} />
          </span>
          {state.label}
        </div>
      ))}
    </div>
  );
}

const meta = {
  title: 'Shared/WorkspaceStatusIcon',
  component: WorkspaceStatusIcon,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof WorkspaceStatusIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Sidebar status: running pulses, every "needs you" request shares one tone. */
export const States: Story = { render: () => <AllStates /> };

export const StatesDark: Story = { ...States, globals: { theme: 'dark' } };
