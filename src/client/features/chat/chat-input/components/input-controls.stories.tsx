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

export const CodexToolbar: Story = {
  args: {
    acpConfigOptions: [
      {
        id: 'mode',
        name: 'Mode',
        type: 'select',
        currentValue: 'agent',
        description: 'Choose how actions are approved.',
        options: [
          {
            value: 'read-only',
            name: 'Read-only',
            description: 'Requires approval to edit files and access the internet.',
          },
          {
            value: 'workspace-write',
            name: 'Workspace access',
            description:
              'Edit workspace files; ask before writing outside the workspace or accessing the network.',
          },
          {
            value: 'agent',
            name: 'Auto review',
            description: 'Only ask for actions detected as potentially unsafe.',
          },
          {
            value: 'agent-full-access',
            name: 'Full access',
            description: 'Unrestricted access to the internet and any file on your computer.',
          },
        ],
      },
      {
        id: 'collaboration_mode',
        name: 'Mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default', description: 'Work directly on the task.' },
          { value: 'plan', name: 'Plan', description: 'Plan before making changes.' },
        ],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'reasoning',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'fast-mode',
        name: 'Fast mode',
        type: 'select',
        currentValue: 'off',
        description: '1.5x speed, increased usage',
        options: [
          { value: 'off', name: 'Off', description: 'Default speed, normal usage' },
          { value: 'on', name: 'On', description: '1.5x speed, increased usage' },
        ],
      },
    ],
  },
};
export const CodexToolbarDark: Story = { ...CodexToolbar, globals: { theme: 'dark' } };

export const ClaudeToolbar: Story = {
  args: {
    capabilities: {
      ...meta.args.capabilities,
      provider: 'CLAUDE',
      model: {
        enabled: true,
        selected: 'sonnet',
        options: [{ value: 'sonnet', label: 'Sonnet 5' }],
      },
      reasoning: { enabled: false, options: [] },
      planMode: { enabled: false },
      attachments: { enabled: true, kinds: ['image'] },
    },
    acpConfigOptions: [
      {
        id: 'mode',
        name: 'Mode',
        type: 'select',
        currentValue: 'acceptEdits',
        description: 'Choose how actions are approved.',
        options: [
          { value: 'default', name: 'Manual', description: 'Always ask before making changes' },
          {
            value: 'acceptEdits',
            name: 'Accept edits',
            description: 'Automatically accept all file edits',
          },
          { value: 'plan', name: 'Plan', description: 'Create a plan before making changes' },
          { value: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
          {
            value: 'bypassPermissions',
            name: 'Bypass permissions',
            description: 'Accepts all permissions',
          },
        ],
      },
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'fast',
        name: 'Fast mode',
        type: 'select',
        currentValue: 'off',
        description: 'Faster responses with increased usage.',
        options: [
          { value: 'off', name: 'Off' },
          { value: 'on', name: 'On' },
        ],
      },
    ],
  },
};
export const ClaudeToolbarDark: Story = { ...ClaudeToolbar, globals: { theme: 'dark' } };
export const FullAccessToolbar: Story = {
  ...CodexToolbar,
  args: {
    ...CodexToolbar.args,
    acpConfigOptions: CodexToolbar.args?.acpConfigOptions?.map((option) =>
      option.id === 'mode' ? { ...option, currentValue: 'agent-full-access' } : option
    ),
  },
};
export const PlanningAndFastEnabled: Story = {
  ...CodexToolbar,
  args: {
    ...CodexToolbar.args,
    acpConfigOptions: CodexToolbar.args?.acpConfigOptions?.map((option) => ({
      ...option,
      currentValue:
        option.id === 'collaboration_mode'
          ? 'plan'
          : option.id === 'fast-mode'
            ? 'on'
            : option.currentValue,
    })),
  },
};

export const ClaudeUnrestrictedAlias: Story = {
  ...ClaudeToolbar,
  args: {
    ...ClaudeToolbar.args,
    acpConfigOptions: ClaudeToolbar.args?.acpConfigOptions?.map((option) =>
      option.id === 'mode'
        ? {
            ...option,
            currentValue: 'dangerouslySkipPermissions',
            options: [
              { value: 'default', name: 'Manual', description: 'Always ask before making changes' },
              {
                value: 'dangerouslySkipPermissions',
                name: 'Bypass permissions',
                description: 'Accepts all permissions',
              },
            ],
          }
        : option
    ),
  },
};
