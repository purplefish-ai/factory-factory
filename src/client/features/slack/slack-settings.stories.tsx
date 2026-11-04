import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { SlackConnectionsView } from './slack-settings';

const meta = {
  title: 'Settings/SlackSettings',
  component: SlackConnectionsView,
  parameters: { layout: 'padded' },
  args: {
    token: '',
    onTokenChange: () => undefined,
    onConnect: () => undefined,
    onTest: () => undefined,
    onDisconnect: () => Promise.resolve({ succeeded: true }),
  },
} satisfies Meta<typeof SlackConnectionsView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { args: { connections: [] } };
export const Connected: Story = {
  args: {
    connections: [
      {
        id: 'slack-1',
        name: 'Purplefish',
        workspaceId: 'T-company',
        hasCredentials: true,
        isEnabled: true,
      },
    ],
  },
};
export const Disconnected: Story = {
  args: {
    connections: [
      {
        id: 'slack-1',
        name: 'Purplefish',
        workspaceId: 'T-company',
        hasCredentials: false,
        isEnabled: false,
      },
    ],
  },
};
export const LongWorkspaceIdentity: Story = {
  args: {
    connections: [
      {
        id: 'constructor',
        name: '北極星社-'.repeat(12),
        workspaceId: `T-${'A'.repeat(200)}-製品部`,
        hasCredentials: false,
        isEnabled: false,
      },
      {
        id: '',
        name: '空の識別子',
        workspaceId: 'T-empty-key',
        hasCredentials: false,
        isEnabled: false,
      },
    ],
  },
};
export const Loading: Story = { args: { loading: true } };
export const ConnectionError: Story = {
  args: {
    error: 'Slack rejected this bot token. Check that it is valid and has not been revoked.',
  },
};
export const Saving: Story = { args: { token: 'xoxb-example', busy: true } };
export const RotatingToken: Story = { args: { token: 'xoxe.xoxb-1-example' } };
export const Interactive: Story = {
  render: function Preview(args) {
    const [token, setToken] = useState('');
    return <SlackConnectionsView {...args} token={token} onTokenChange={setToken} />;
  },
};

export const RecoveredMetadata: Story = {
  args: {
    connections: [
      {
        id: 'slack-recovered-enabled',
        name: 'Imported Slack A',
        workspaceId: 'T-recovered-enabled',
        hasCredentials: false,
        isEnabled: false,
      },
      {
        id: 'slack-recovered-disabled',
        name: 'Imported Slack B',
        workspaceId: 'T-recovered-disabled',
        hasCredentials: false,
        isEnabled: false,
      },
    ],
  },
  render: function Recovered(args) {
    const [token, setToken] = useState('');
    const [notice, setNotice] = useState('');
    return (
      <>
        <SlackConnectionsView
          {...args}
          token={token}
          onTokenChange={setToken}
          onConnect={() => setNotice('Reconnect requested for the supplied bot token.')}
        />
        {notice && <p role="status">{notice}</p>}
      </>
    );
  },
};
