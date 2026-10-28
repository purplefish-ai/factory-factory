import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import type { ChatProvider } from '@/shared/chat-capabilities';
import { SessionLaunchControls } from './session-launch-controls';

interface Draft {
  model: string;
  effort: string | null;
  plan: boolean;
}
interface PreviewProps {
  state?: 'ready' | 'loading' | 'error' | 'invalid' | 'unsupported';
  longLabels?: boolean;
}
function LaunchControlsPreview({ state = 'ready', longLabels = false }: PreviewProps) {
  const [provider, setProvider] = useState<ChatProvider>('CODEX');
  const [drafts, setDrafts] = useState<Record<ChatProvider, Draft>>({
    CODEX: {
      model: state === 'invalid' ? 'luna' : 'sol',
      effort: state === 'invalid' ? 'ultra' : 'high',
      plan: state === 'unsupported',
    },
    CLAUDE: { model: 'sonnet', effort: null, plan: false },
  });
  const draft = drafts[provider];
  const update = (patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [provider]: { ...current[provider], ...patch } }));
  const modelLabel = longLabels ? 'GPT-6.1 Terra Codex — extended context and reasoning' : '6 Sol';
  const providerOptions = {
    CLAUDE: {
      defaultModel: 'sonnet',
      models: [
        { value: 'sonnet', label: 'Sonnet' },
        { value: 'opus', label: 'Opus' },
      ],
    },
    CODEX: {
      defaultModel: 'sol',
      models: [
        { value: 'sol', label: modelLabel },
        { value: 'luna', label: '6 Luna' },
      ],
    },
  };
  const values =
    provider === 'CLAUDE'
      ? ['default', 'low', 'medium', 'high', 'xhigh', 'max']
      : draft.model === 'luna'
        ? ['low', 'medium', 'high', 'xhigh', 'max']
        : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const options =
    state === 'unsupported'
      ? []
      : values.map((value) => ({
          value,
          label:
            value === 'xhigh'
              ? 'Extra high'
              : value === 'high' && longLabels
                ? 'Maximum advertised thinking level'
                : value.slice(0, 1).toUpperCase() + value.slice(1),
        }));
  const invalid = state === 'invalid' && draft.effort === 'ultra';
  return (
    <div className="w-[min(40rem,calc(100vw-2rem))] rounded-lg border p-2">
      <SessionLaunchControls
        provider={provider}
        model={draft.model}
        models={providerOptions[provider].models}
        providerOptions={providerOptions}
        onProviderChange={(next, model) => {
          setProvider(next);
          setDrafts((current) => ({
            ...current,
            [next]: { ...current[next], model: model ?? providerOptions[next].defaultModel },
          }));
        }}
        onModelChange={(model) => update({ model })}
        reasoning={{
          value: draft.effort,
          options,
          defaultValue: provider === 'CLAUDE' ? 'default' : 'low',
          loading: state === 'loading',
          error: state === 'error' ? 'Could not load thinking and planning options' : undefined,
          invalid,
          onChange: (effort) => update({ effort }),
          onRetry: () => undefined,
        }}
        planMode={{
          enabled: draft.plan,
          supported: state !== 'unsupported',
          loading: state === 'loading',
          error: state === 'error' ? 'Could not load thinking and planning options' : undefined,
          onChange: (plan) => update({ plan }),
        }}
      />
    </div>
  );
}
const meta = {
  title: 'Chat/Input/SessionLaunchControls',
  component: LaunchControlsPreview,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof LaunchControlsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Interactive: Story = {};
export const Dark: Story = { globals: { theme: 'dark' } };
export const Loading: Story = { args: { state: 'loading' } };
export const FailedDiscovery: Story = { args: { state: 'error' } };
export const UnsupportedSelection: Story = { args: { state: 'invalid' } };
export const UnsupportedPlan: Story = { args: { state: 'unsupported' } };
export const LongLabels: Story = { args: { longLabels: true } };
export const Narrow: Story = { ...LongLabels, parameters: { viewport: { value: 'mobile1' } } };
