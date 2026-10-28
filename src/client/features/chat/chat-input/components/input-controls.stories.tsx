import type { Meta, StoryObj } from '@storybook/react';
import { createRef } from 'react';
import { fn } from 'storybook/test';
import { DEFAULT_CHAT_SETTINGS } from '@/lib/chat-protocol';
import { EMPTY_CHAT_BAR_CAPABILITIES } from '@/shared/chat-capabilities';
import { LeftControls } from './input-controls';

const meta = {
  title: 'Chat/Input/SelectionControls',
  component: LeftControls,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div className="flex w-[min(32rem,calc(100vw-2rem))] rounded-lg border p-2">
        <Story />
      </div>
    ),
  ],
  args: {
    capabilities: {
      ...EMPTY_CHAT_BAR_CAPABILITIES,
      provider: 'CODEX',
      model: {
        enabled: true,
        selected: 'six-sol',
        options: [
          { value: 'six-sol', label: '6 Sol' },
          { value: 'six-luna', label: '6 Luna' },
        ],
      },
      reasoning: {
        enabled: true,
        selected: 'high',
        options: [
          { value: 'high', label: 'High' },
          { value: 'low', label: 'Low' },
        ],
      },
      planMode: { enabled: true },
    },
    onSetConfigOption: fn(),
    onModelChange: fn(),
    onReasoningChange: fn(),
    onThinkingChange: fn(),
    onPlanModeChange: fn(),
    running: false,
    disabled: false,
    modLabel: '⌘',
    modifierHeld: false,
    fileInputRef: createRef<HTMLInputElement>(),
    onFileSelect: fn(),
    supportedImageTypes: ['image/png'],
    onQuickAction: fn(),
    quickActionsOpen: false,
    onQuickActionsOpenChange: fn(),
  },
} satisfies Meta<typeof LeftControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Capabilities: Story = {};
export const PartialAcp: Story = {
  args: {
    acpConfigOptions: [
      {
        id: 'mode',
        name: 'Access',
        type: 'select',
        currentValue: 'workspace-write',
        options: [
          { value: 'workspace-write', name: 'Workspace access' },
          { value: 'read-only', name: 'Read-only' },
        ],
      },
    ],
  },
};
export const PartialAcpDark: Story = { ...PartialAcp, globals: { theme: 'dark' } };
export const Loading: Story = {
  args: { capabilities: EMPTY_CHAT_BAR_CAPABILITIES, capabilitiesLoaded: false },
};
export const Narrow: Story = { ...PartialAcp, parameters: { viewport: { value: 'mobile1' } } };

export const PendingNativeAcknowledgement: Story = {
  args: {
    settings: { ...DEFAULT_CHAT_SETTINGS, selectedModel: 'six-luna' },
    acpConfigOptions: [
      {
        id: 'runtime-model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'six-sol',
        options: [
          { value: 'six-sol', name: '6 Sol' },
          { value: 'six-luna', name: '6 Luna' },
        ],
      },
    ],
  },
};

export const LoadedEmptyCapabilities: Story = {
  args: { capabilities: EMPTY_CHAT_BAR_CAPABILITIES, capabilitiesLoaded: true },
};

export const UnconfirmedEffort: Story = {
  args: {
    capabilities: {
      ...meta.args.capabilities,
      reasoning: {
        enabled: true,
        options: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
      },
    },
  },
};

export const BeforeRuntimeConfiguration: Story = {
  args: {
    capabilities: {
      ...meta.args.capabilities,
      reasoning: { enabled: false, options: [] },
      planMode: { enabled: false },
    },
  },
};
