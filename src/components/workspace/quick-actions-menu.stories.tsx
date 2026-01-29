import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { TooltipProvider } from '@/components/ui/tooltip';

// Since QuickActionsMenu uses tRPC, we need to create a mock version for stories
// that doesn't depend on the actual tRPC hook

const mockQuickActions = [
  {
    id: 'commit',
    name: 'Commit Changes',
    description: 'Stage and commit current changes',
    type: 'agent' as const,
    icon: 'check',
    prompt: '/commit',
  },
  {
    id: 'review',
    name: 'Review Code',
    description: 'Review and suggest improvements',
    type: 'agent' as const,
    icon: 'eye',
    prompt: '/review',
  },
  {
    id: 'test',
    name: 'Run Tests',
    description: 'Execute test suite',
    type: 'agent' as const,
    icon: 'play',
    prompt: '/test',
  },
];

// Mock component that doesn't use tRPC
function MockQuickActionsMenu({
  onExecuteAgent,
  disabled = false,
  actions = mockQuickActions,
  isLoading = false,
}: {
  onExecuteAgent: (action: (typeof mockQuickActions)[0]) => void;
  disabled?: boolean;
  actions?: typeof mockQuickActions;
  isLoading?: boolean;
}) {
  const { Check, Eye, Play, Zap } = require('lucide-react');
  const { Button } = require('@/components/ui/button');
  const {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
  } = require('@/components/ui/dropdown-menu');
  const { Tooltip, TooltipContent, TooltipTrigger } = require('@/components/ui/tooltip');

  const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
    check: Check,
    eye: Eye,
    play: Play,
    zap: Zap,
  };

  const hasActions = actions.length > 0;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={disabled || isLoading || !hasActions}
            >
              <Zap className="h-4 w-4" />
              <span className="sr-only">Quick Actions</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Quick Actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Quick Actions</DropdownMenuLabel>
        {actions.map((action) => {
          const Icon = iconMap[action.icon || 'zap'] || Zap;
          return (
            <DropdownMenuItem
              key={action.id}
              onClick={() => onExecuteAgent(action)}
              className="cursor-pointer"
            >
              <Icon className="mr-2 h-4 w-4" />
              <div className="flex flex-col">
                <span>{action.name}</span>
                <span className="text-xs text-muted-foreground">{action.description}</span>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const meta = {
  title: 'Workspace/QuickActionsMenu',
  component: MockQuickActionsMenu,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <TooltipProvider>
        <div className="p-8">
          <Story />
        </div>
      </TooltipProvider>
    ),
  ],
  args: {
    onExecuteAgent: fn(),
  },
} satisfies Meta<typeof MockQuickActionsMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    actions: mockQuickActions,
  },
};

export const SingleAction: Story = {
  args: {
    actions: [mockQuickActions[0]],
  },
};

export const ManyActions: Story = {
  args: {
    actions: [
      ...mockQuickActions,
      {
        id: 'lint',
        name: 'Lint Code',
        description: 'Run linter and fix issues',
        type: 'agent' as const,
        icon: 'sparkles',
        prompt: '/lint',
      },
      {
        id: 'build',
        name: 'Build Project',
        description: 'Build for production',
        type: 'agent' as const,
        icon: 'terminal',
        prompt: '/build',
      },
    ],
  },
};

export const Disabled: Story = {
  args: {
    actions: mockQuickActions,
    disabled: true,
  },
};

export const Loading: Story = {
  args: {
    actions: [],
    isLoading: true,
  },
};

export const NoActions: Story = {
  args: {
    actions: [],
  },
};
