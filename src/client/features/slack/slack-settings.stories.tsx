import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { SlackConnectionSummary } from '@/shared/slack-connection';
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
    onAppTokenEdit: () => undefined,
    onAppTokenChange: () => undefined,
    onSaveAppToken: () => undefined,
    onClearAppToken: () => Promise.resolve({ succeeded: true }),
  },
} satisfies Meta<typeof SlackConnectionsView>;
export default meta;
type Story = StoryObj<typeof meta>;
const withAppToken: SlackConnectionSummary = {
  id: 'slack-1',
  name: 'Purplefish',
  workspaceId: 'T-company',
  hasCredentials: true,
  isEnabled: true,
  hasAppToken: true,
  appId: 'A0123456789',
};
export const Empty: Story = { args: { connections: [] } };
export const AppTokenSaved: Story = { args: { connections: [withAppToken] } };
export const AppTokenSavedPhone: Story = {
  args: { connections: [withAppToken] },
  globals: { viewport: { value: 'phone', isRotated: false } },
};
export const EnteringAppToken: Story = {
  args: {
    connections: [{ ...withAppToken, hasAppToken: false, appId: null }],
    appTokenDraft: { connectionId: 'slack-1', token: 'xapp-1-A0123456789-example' },
  },
};
export const SavingAppToken: Story = {
  args: {
    connections: [{ ...withAppToken, hasAppToken: false, appId: null }],
    appTokenDraft: { connectionId: 'slack-1', token: 'xapp-1-A0123456789-example' },
    pending: { kind: 'setAppToken', connectionId: 'slack-1' },
  },
};
export const AppTokenRejected: Story = {
  args: {
    connections: [{ ...withAppToken, hasAppToken: false, appId: null }],
    appTokenDraft: { connectionId: 'slack-1', token: 'xapp-1-A0999999999-example' },
    error:
      'This app-level token belongs to a different Slack app than the bot token. Create the token in the same Slack app.',
  },
};
/** Replacing a saved token opens an empty, masked field; the saved token is never shown. */
export const ReplacingAppToken: Story = {
  args: { connections: [withAppToken] },
  render: function ReplaceAppToken(args) {
    const [draft, setDraft] = useState<{ connectionId: string; token: string }>();
    return (
      <SlackConnectionsView
        {...args}
        appTokenDraft={draft}
        onAppTokenEdit={(connectionId) =>
          setDraft(connectionId ? { connectionId, token: '' } : undefined)
        }
        onAppTokenChange={(token) => setDraft((current) => current && { ...current, token })}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Replace app token' }));
    const input = canvas.getByLabelText('App-level token');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(input).toHaveValue('');
    await expect(canvas.getByRole('button', { name: 'Save app token' })).toBeDisabled();
    await userEvent.type(input, 'xapp-1-A0123456789-example');
    await expect(canvas.getByRole('button', { name: 'Save app token' })).toBeEnabled();
  },
};
export const RemovingAppToken: Story = {
  args: { connections: [withAppToken] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Remove app token' }));
    const dialog = within(canvasElement.ownerDocument.body).getByRole('alertdialog');
    await expect(dialog).toHaveTextContent('The bot token stays connected');
  },
};
export const Connected: Story = {
  args: {
    connections: [
      {
        id: 'slack-1',
        name: 'Purplefish',
        workspaceId: 'T-company',
        hasCredentials: true,
        isEnabled: true,
        hasAppToken: false,
        appId: null,
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
        hasAppToken: false,
        appId: null,
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
        hasAppToken: false,
        appId: null,
      },
      {
        id: '',
        name: '空の識別子',
        workspaceId: 'T-empty-key',
        hasCredentials: false,
        isEnabled: false,
        hasAppToken: false,
        appId: null,
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
export const Saving: Story = { args: { token: 'xoxb-example', pending: { kind: 'connect' } } };
/** Only the row being tested shows the spinner; every other control waits. */
export const TestingOneConnection: Story = {
  args: {
    pending: { kind: 'test', connectionId: 'slack-2' },
    connections: [
      {
        id: 'slack-1',
        name: 'Purplefish',
        workspaceId: 'T-company',
        hasCredentials: true,
        isEnabled: true,
        hasAppToken: false,
        appId: null,
      },
      {
        id: 'slack-2',
        name: 'Purplefish Labs',
        workspaceId: 'T-labs',
        hasCredentials: true,
        isEnabled: true,
        hasAppToken: false,
        appId: null,
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const testing = canvas.getByRole('button', { name: 'Testing…' });
    await expect(testing).toHaveAttribute('aria-busy', 'true');
    await expect(canvas.getAllByRole('button', { name: 'Testing…' })).toHaveLength(1);
    await expect(canvas.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  },
};
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
        hasAppToken: false,
        appId: null,
      },
      {
        id: 'slack-recovered-disabled',
        name: 'Imported Slack B',
        workspaceId: 'T-recovered-disabled',
        hasCredentials: false,
        isEnabled: false,
        hasAppToken: false,
        appId: null,
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
