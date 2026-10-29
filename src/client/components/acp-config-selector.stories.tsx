import type { Meta, StoryObj } from '@storybook/react';
import { useArgs } from 'storybook/preview-api';
import { fn } from 'storybook/test';
import type { AcpConfigOption } from '@/client/lib/acp-config';
import { AcpConfigSelector } from './acp-config-selector';

const modelOption: AcpConfigOption = {
  id: 'model',
  name: 'Model',
  type: 'select',
  category: 'model',
  currentValue: 'sonnet',
  options: [
    { value: 'default', name: 'Default — Opus 4.8 (1M)' },
    { value: 'opus[1m]', name: 'Opus 4.8 (1M)' },
    { value: 'claude-fable-5[1m]', name: 'Fable 5' },
    { value: 'sonnet', name: 'Sonnet 5' },
    { value: 'haiku', name: 'Haiku 4.5' },
  ],
};

const meta = {
  title: 'Chat/Input/AcpConfigSelector',
  component: AcpConfigSelector,
  parameters: { layout: 'centered' },
  args: {
    configOption: modelOption,
    onSelect: fn(),
    disabled: false,
  },
} satisfies Meta<typeof AcpConfigSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeModels: Story = {};

export const CodexAccess: Story = {
  args: {
    configOption: {
      id: 'mode',
      name: 'Access',
      type: 'select',
      category: 'mode',
      currentValue: 'workspace-write',
      options: [
        { value: 'read-only', name: 'Read-only' },
        { value: 'workspace-write', name: 'Workspace access' },
        { value: 'agent', name: 'Auto review' },
        { value: 'agent-full-access', name: 'Full access' },
      ],
    },
  },
};

function InteractiveToggle(args: React.ComponentProps<typeof AcpConfigSelector>) {
  const [, updateArgs] = useArgs();
  return (
    <AcpConfigSelector
      {...args}
      onSelect={(id, value) => {
        args.onSelect(id, value);
        updateArgs({ configOption: { ...args.configOption, currentValue: value } });
      }}
    />
  );
}

export const CodexPlanning: Story = {
  render: InteractiveToggle,
  args: {
    configOption: {
      id: 'collaboration_mode',
      name: 'Planning',
      type: 'select',
      category: 'collaboration_mode',
      currentValue: 'plan',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  },
};

export const FastMode: Story = {
  render: InteractiveToggle,
  args: {
    configOption: {
      id: 'fast-mode',
      name: 'Fast mode',
      type: 'select',
      currentValue: 'off',
      description: 'Faster responses with increased usage.',
      options: [
        { value: 'off', name: 'Off' },
        { value: 'on', name: 'On' },
      ],
    },
  },
};
export const FastModeEnabled: Story = {
  ...FastMode,
  args: { configOption: { ...FastMode.args!.configOption!, currentValue: 'on' } },
};
export const Ultracode: Story = {
  render: InteractiveToggle,
  args: {
    configOption: {
      id: 'ultracode',
      name: 'Ultracode',
      type: 'select',
      category: 'model_config',
      currentValue: 'off',
      description: 'Dynamic workflows on every task, at any effort level',
      options: [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' },
      ],
    },
  },
};
export const UltracodeEnabled: Story = {
  ...Ultracode,
  args: { configOption: { ...Ultracode.args!.configOption!, currentValue: 'on' } },
};
export const UltracodeMobile: Story = {
  ...Ultracode,
  args: { ...Ultracode.args, compact: false },
};
export const DisabledPlanning: Story = {
  ...CodexPlanning,
  args: { ...CodexPlanning.args, disabled: true },
};
