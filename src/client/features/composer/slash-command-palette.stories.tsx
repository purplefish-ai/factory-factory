import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { fn } from 'storybook/test';
import type { CommandInfo } from '@/lib/chat-protocol';
import { SlashCommandPalette } from './slash-command-palette';

// Action handlers for Storybook
const onCloseAction = fn();
const onSelectAction = fn();

const meta: Meta<typeof SlashCommandPalette> = {
  title: 'Chat/SlashCommandPalette',
  component: SlashCommandPalette,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="relative w-[500px] h-[300px] bg-background border rounded-lg p-4 flex flex-col justify-end">
        <Story />
        <div className="h-10 border rounded-md bg-muted/50 flex items-center px-3">
          <span className="text-muted-foreground text-sm">Simulated input field</span>
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SlashCommandPalette>;

const sampleCommands: CommandInfo[] = [
  {
    name: 'help',
    description: 'Get help with using Claude Code',
    argumentHint: '',
  },
  {
    name: 'commit',
    description: 'Create a git commit with the current changes',
    argumentHint: '[message]',
  },
  {
    name: 'review-pr',
    description: 'Review a pull request',
    argumentHint: '<pr-number>',
  },
  {
    name: 'init',
    description: 'Initialize a new project with Claude Code',
    argumentHint: '',
  },
  {
    name: 'status',
    description: 'Show the current status of the project',
    argumentHint: '',
  },
  {
    name: 'config',
    description: 'Configure Claude Code settings',
    argumentHint: '[key] [value]',
  },
  {
    name: 'clear',
    description: 'Clear the conversation history',
    argumentHint: '',
  },
  {
    name: 'bug',
    description: 'Report a bug in the current code',
    argumentHint: '[description]',
  },
];

/**
 * Interactive story with state management
 */
function InteractivePalette() {
  const [isOpen, setIsOpen] = useState(true);
  const [filter, setFilter] = useState('');
  const anchorRef = useRef<HTMLDivElement>(null);

  return (
    <div className="w-full">
      <SlashCommandPalette
        commands={sampleCommands}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onSelect={() => {
          setIsOpen(false);
        }}
        filter={filter}
        anchorRef={anchorRef}
      />
      <div ref={anchorRef} className="flex items-center gap-2">
        <input
          type="text"
          value={`/${filter}`}
          onChange={(e) => {
            const value = e.target.value;
            if (value.startsWith('/')) {
              setFilter(value.slice(1));
              setIsOpen(true);
            } else {
              setFilter('');
              setIsOpen(false);
            }
          }}
          onFocus={() => {
            setIsOpen(true);
          }}
          placeholder="Type / to see commands..."
          className="flex-1 h-10 border rounded-md px-3 text-sm bg-background"
        />
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="px-3 h-10 border rounded-md text-sm"
        >
          Toggle
        </button>
      </div>
    </div>
  );
}

export const Interactive: Story = {
  render: () => <InteractivePalette />,
};

/**
 * Default state with no filter
 */
export const Default: Story = {
  args: {
    commands: sampleCommands,
    isOpen: true,
    onClose: onCloseAction,
    onSelect: onSelectAction,
    filter: '',
    anchorRef: { current: null },
  },
};

/**
 * With filter applied
 */
export const WithFilter: Story = {
  args: {
    commands: sampleCommands,
    isOpen: true,
    onClose: onCloseAction,
    onSelect: onSelectAction,
    filter: 'co',
    anchorRef: { current: null },
  },
};

/**
 * Few commands
 */
export const FewCommands: Story = {
  args: {
    commands: sampleCommands.slice(0, 3),
    isOpen: true,
    onClose: onCloseAction,
    onSelect: onSelectAction,
    filter: '',
    anchorRef: { current: null },
  },
};

/**
 * No matching commands
 */
export const NoMatches: Story = {
  args: {
    commands: sampleCommands,
    isOpen: true,
    onClose: onCloseAction,
    onSelect: onSelectAction,
    filter: 'xyz',
    anchorRef: { current: null },
  },
};

/**
 * Closed state
 */
export const Closed: Story = {
  args: {
    commands: sampleCommands,
    isOpen: false,
    onClose: onCloseAction,
    onSelect: onSelectAction,
    filter: '',
    anchorRef: { current: null },
  },
};
