import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { CodexAccountSummary } from '@/shared/codex-accounts';
import { CodexAccountLoginDialog } from './codex-account-login-dialog';
import { CodexAccountsView } from './codex-accounts-settings';

const example = (id: string, label: string, percent: number): CodexAccountSummary => ({
  id,
  label,
  kind: id === 'native' ? 'NATIVE_DEFAULT' : 'MANAGED',
  enabled: true,
  authenticated: true,
  email: `${label.toLowerCase().replaceAll(' ', '-')}@example.com`,
  planType: 'Plus',
  usage: {
    provider: 'CODEX',
    status: 'available',
    updatedAt: '2026-10-29T12:00:00Z',
    windows: [
      { id: 'short', label: '5-hour limit', usedPercent: percent, resetsAt: 1_793_332_800 },
      {
        id: 'weekly',
        label: 'Weekly limit',
        usedPercent: Math.min(100, percent + 12),
        resetsAt: 1_793_764_800,
      },
    ],
  },
});
function Preview({
  many = false,
  single = false,
  unavailable = false,
}: {
  many?: boolean;
  single?: boolean;
  unavailable?: boolean;
}) {
  const [accounts, setAccounts] = useState(() =>
    single
      ? [example('native', 'Native Codex', 24)]
      : many
        ? Array.from({ length: 7 }, (_, i) => example(String(i), `Account ${i + 1}`, i * 14))
        : [
            example('native', 'Personal', 94),
            { ...example('work', 'Work', 31), enabled: false },
            {
              ...example('unverified', 'New account', 0),
              authenticated: false,
              email: null,
              usage: {
                provider: 'CODEX' as const,
                status: 'unavailable' as const,
                updatedAt: '2026-10-29T12:00:00Z',
                windows: [],
                message: 'Sign in to read plan limits.',
              },
            },
          ]
  );
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full max-w-2xl">
      <CodexAccountsView
        accounts={unavailable ? undefined : accounts}
        error={
          unavailable
            ? 'Account management is available only from a trusted local connection.'
            : undefined
        }
        onAdd={() => setOpen(true)}
        onLogin={() => setOpen(true)}
        onUpdate={(id, enabled) =>
          setAccounts((accounts) =>
            accounts.map((account) => (account.id === id ? { ...account, enabled } : account))
          )
        }
      />
      <CodexAccountLoginDialog
        open={open}
        onClose={() => setOpen(false)}
        onCancel={() => setOpen(false)}
        onSubmit={() => setOpen(false)}
      />
    </div>
  );
}
const meta = {
  title: 'Settings/Codex Accounts',
  component: Preview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MultipleAccounts: Story = {};
export const SingleNativeAccount: Story = { args: { single: true } };
export const ManyAccounts: Story = { args: { many: true } };
export const RemoteConnection: Story = { args: { unavailable: true } };
export const Dark: Story = { globals: { theme: 'dark' } };
export const PendingLogin: Story = {
  render: () => (
    <CodexAccountLoginDialog
      open
      onClose={() => undefined}
      onCancel={() => undefined}
      onSubmit={() => undefined}
      login={{
        accountId: 'work',
        status: 'pending',
        authorizationUrl: 'https://auth.openai.com/example',
      }}
    />
  ),
};
export const CompletedLogin: Story = {
  render: () => (
    <CodexAccountLoginDialog
      open
      onClose={() => undefined}
      onCancel={() => undefined}
      onSubmit={() => undefined}
      login={{ accountId: 'work', status: 'completed' }}
    />
  ),
};
export const FailedLogin: Story = {
  render: () => (
    <CodexAccountLoginDialog
      open
      onClose={() => undefined}
      onCancel={() => undefined}
      onSubmit={() => undefined}
      login={{
        accountId: 'work',
        status: 'failed',
        message: 'The login expired. Start sign-in again from your account list.',
      }}
    />
  ),
};

export const NativeNeedsLogin: Story = {
  render: () => (
    <div className="w-full max-w-2xl">
      <CodexAccountsView
        accounts={[
          {
            ...example('native', 'Native Codex', 0),
            authenticated: false,
            email: null,
            usage: {
              provider: 'CODEX',
              status: 'unavailable',
              updatedAt: '2026-10-29T12:00:00Z',
              windows: [],
              message: 'Sign in to read plan limits.',
            },
          },
        ]}
        onAdd={() => undefined}
        onLogin={() => undefined}
        onUpdate={() => undefined}
      />
    </div>
  ),
};
