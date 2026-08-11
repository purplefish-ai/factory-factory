import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { AcpConfigOption } from '@/client/features/chat/reducer';
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
