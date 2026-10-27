import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import type { ChatProvider } from '@/shared/chat-capabilities';
import { ProviderModelPicker } from './provider-model-picker';

const models = [
  { value: 'six-sol', label: '6 Sol' },
  { value: 'six-luna', label: '6 Luna' },
];
const meta = {
  title: 'Chat/Input/ProviderModelPicker',
  component: ProviderModelPicker,
  parameters: { layout: 'centered' },
  args: { provider: 'CODEX', model: 'six-sol', models, onModelChange: fn() },
} satisfies Meta<typeof ProviderModelPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentConversation: Story = {};
export const ApplyingModelSelection: Story = { args: { model: 'six-luna', updating: true } };
export const Dark: Story = { globals: { theme: 'dark' } };
export const Loading: Story = {
  args: { provider: null, model: undefined, models: [], loading: true },
};
export const Disconnected: Story = {
  args: {
    disabled: true,
    disabledReason: 'Model selection is unavailable while the session is disconnected or starting',
  },
};
export const Running: Story = {
  args: { disabled: true, disabledReason: 'Wait for the agent to stop before changing models' },
};
export const UnknownModel: Story = { args: { model: 'custom-provider-model' } };
export const CatalogLoading: Story = {
  args: { models: [], modelsLoading: true, onProviderChange: fn() },
};
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="flex w-40 border rounded-md p-1">
        <Story />
      </div>
    ),
  ],
};
export const NewConversation: Story = {
  render: function NewConversationPicker() {
    const [provider, setProvider] = useState<ChatProvider>('CODEX');
    const [model, setModel] = useState('six-sol');
    const options =
      provider === 'CODEX'
        ? models
        : [
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'opus', label: 'Opus' },
          ];
    return (
      <ProviderModelPicker
        provider={provider}
        model={model}
        models={options}
        onModelChange={setModel}
        onProviderChange={(next) => {
          setProvider(next);
          setModel(next === 'CODEX' ? 'six-sol' : 'sonnet');
        }}
      />
    );
  },
};
