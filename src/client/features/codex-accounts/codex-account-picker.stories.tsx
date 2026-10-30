import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { CodexAccountPicker } from './codex-account-picker';

function Preview() {
  const [value, setValue] = useState<string>();
  return (
    <CodexAccountPicker
      value={value}
      onChange={setValue}
      accounts={[
        {
          id: 'native',
          label: 'Native Codex',
          kind: 'NATIVE_DEFAULT',
          authenticated: false,
          enabled: true,
        },
        { id: 'work', label: 'Work', kind: 'MANAGED', authenticated: false, enabled: true },
        { id: 'personal', label: 'Personal', kind: 'MANAGED', authenticated: true, enabled: false },
      ]}
    />
  );
}

const meta = {
  title: 'Settings/Codex Account Picker',
  component: Preview,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReconnectInstructions: Story = {};
export const Dark: Story = { globals: { theme: 'dark' } };
