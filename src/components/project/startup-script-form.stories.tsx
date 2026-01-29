import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { type ScriptType, StartupScriptForm } from './startup-script-form';

const meta = {
  title: 'Project/StartupScriptForm',
  component: StartupScriptForm,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[400px] p-4 border rounded">
        <Story />
      </div>
    ),
  ],
  args: {
    onScriptTypeChange: fn(),
    onStartupScriptChange: fn(),
  },
} satisfies Meta<typeof StartupScriptForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CommandMode: Story = {
  args: {
    scriptType: 'command',
    startupScript: '',
  },
};

export const PathMode: Story = {
  args: {
    scriptType: 'path',
    startupScript: '',
  },
};

export const CommandWithValue: Story = {
  args: {
    scriptType: 'command',
    startupScript: 'npm install && npm run build',
  },
};

export const PathWithValue: Story = {
  args: {
    scriptType: 'path',
    startupScript: './scripts/setup.sh',
  },
};

export const WithHeader: Story = {
  args: {
    scriptType: 'command',
    startupScript: '',
    hideHeader: false,
  },
};

export const WithoutHeader: Story = {
  args: {
    scriptType: 'command',
    startupScript: '',
    hideHeader: true,
  },
};

function InteractiveForm() {
  const [scriptType, setScriptType] = useState<ScriptType>('command');
  const [startupScript, setStartupScript] = useState('');

  return (
    <StartupScriptForm
      scriptType={scriptType}
      onScriptTypeChange={setScriptType}
      startupScript={startupScript}
      onStartupScriptChange={setStartupScript}
    />
  );
}

export const Interactive: Story = {
  render: () => <InteractiveForm />,
  args: {
    scriptType: 'command',
    startupScript: '',
  },
};
