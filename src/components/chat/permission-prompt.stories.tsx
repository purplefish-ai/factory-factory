import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import {
  createPermissionRequest,
  createPlanApprovalRequest,
  SAMPLE_FILE_PATHS,
} from '@/lib/claude-fixtures';

import { PermissionPrompt, PermissionPromptExpanded } from './permission-prompt';

const meta = {
  title: 'Chat/PermissionPrompt',
  component: PermissionPrompt,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="max-w-2xl border rounded-lg overflow-hidden">
        <div className="p-4 bg-background min-h-[100px]">
          <p className="text-sm text-muted-foreground">Chat messages would appear above...</p>
        </div>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    permission: {
      control: 'object',
      description: 'The permission request to display, or null to hide the prompt',
    },
    onApprove: {
      action: 'onApprove',
      description: 'Callback when permission is approved or denied',
    },
  },
  args: {
    onApprove: fn(),
  },
} satisfies Meta<typeof PermissionPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadFile: Story = {
  args: {
    permission: createPermissionRequest('Read', {
      file_path: SAMPLE_FILE_PATHS.typescript,
    }),
  },
};

export const WriteFile: Story = {
  args: {
    permission: createPermissionRequest('Write', {
      file_path: SAMPLE_FILE_PATHS.typescript,
      content: `import React from 'react';

interface ButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

export function Button({ label, onClick, variant = 'primary' }: ButtonProps) {
  return (
    <button className={\`btn btn-\${variant}\`} onClick={onClick}>
      {label}
    </button>
  );
}`,
    }),
  },
};

export const BashCommand: Story = {
  args: {
    permission: createPermissionRequest('Bash', {
      command: 'npm run build && npm test',
      description: 'Build the project and run tests',
    }),
  },
};

export const EditFile: Story = {
  args: {
    permission: createPermissionRequest('Edit', {
      file_path: SAMPLE_FILE_PATHS.typescript,
      old_string: "variant = 'primary'",
      new_string: "variant = 'secondary'",
    }),
  },
};

export const GlobSearch: Story = {
  args: {
    permission: createPermissionRequest('Glob', {
      pattern: '**/*.tsx',
      path: '/Users/developer/project/src',
    }),
  },
};

export const PlanApproval: Story = {
  args: {
    permission: createPlanApprovalRequest('/Users/developer/.claude/plans/refactor-auth-system.md'),
  },
  parameters: {
    docs: {
      description: {
        story:
          'Plan approval request when the agent is in plan mode and needs user approval to proceed with implementation.',
      },
    },
  },
};

export const LongCommand: Story = {
  args: {
    permission: createPermissionRequest('Bash', {
      command:
        'docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build --remove-orphans -d && docker compose logs -f',
      description: 'Start all development services with Docker Compose',
    }),
  },
};

export const NoPermission: Story = {
  args: {
    permission: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'When permission is null, the prompt is hidden and nothing is rendered.',
      },
    },
  },
};

// Expanded variant stories
const expandedMeta = {
  title: 'Chat/PermissionPromptExpanded',
  component: PermissionPromptExpanded,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  decorators: [
    (Story: React.ComponentType) => (
      <div className="max-w-2xl border rounded-lg overflow-hidden">
        <div className="p-4 bg-background min-h-[100px]">
          <p className="text-sm text-muted-foreground">Chat messages would appear above...</p>
        </div>
        <Story />
      </div>
    ),
  ],
  argTypes: {
    permission: {
      control: 'object',
      description: 'The permission request to display, or null to hide the prompt',
    },
    onApprove: {
      action: 'onApprove',
      description: 'Callback when permission is approved or denied',
    },
  },
  args: {
    onApprove: fn(),
  },
} satisfies Meta<typeof PermissionPromptExpanded>;

type ExpandedStory = StoryObj<typeof expandedMeta>;

export const ExpandedBashCommand: ExpandedStory = {
  render: (args) => <PermissionPromptExpanded {...args} />,
  args: {
    permission: createPermissionRequest('Bash', {
      command: 'docker compose up -d',
      description: 'Start all services in detached mode',
      timeout: 30_000,
      cwd: '/Users/developer/project',
      env: {
        NODE_ENV: 'development',
        DEBUG: 'true',
        DATABASE_URL: 'postgres://localhost:5432/mydb',
      },
    }),
  },
};

export const ExpandedWriteFile: ExpandedStory = {
  render: (args) => <PermissionPromptExpanded {...args} />,
  args: {
    permission: createPermissionRequest('Write', {
      file_path: SAMPLE_FILE_PATHS.typescript,
      content: `import React from 'react';

interface ButtonProps {
  label: string;
  onClick: () => void;
}

export function Button({ label, onClick }: ButtonProps) {
  return (
    <button onClick={onClick}>
      {label}
    </button>
  );
}`,
    }),
  },
};

export const ExpandedPlanApproval: ExpandedStory = {
  render: (args) => <PermissionPromptExpanded {...args} />,
  args: {
    permission: createPlanApprovalRequest('/Users/developer/.claude/plans/implement-dark-mode.md'),
  },
  parameters: {
    docs: {
      description: {
        story: 'Expanded plan approval showing the full plan file path and requested permissions.',
      },
    },
  },
};
