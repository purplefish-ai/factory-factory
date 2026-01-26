import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { createPermissionRequest, SAMPLE_FILE_PATHS } from '@/lib/claude-fixtures';

import { PermissionModal } from './permission-modal';

const meta = {
  title: 'Chat/PermissionModal',
  component: PermissionModal,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    permission: {
      control: 'object',
      description: 'The permission request to display, or null to hide the modal',
    },
    onApprove: {
      action: 'onApprove',
      description: 'Callback when permission is approved or denied',
    },
  },
  args: {
    onApprove: fn(),
  },
} satisfies Meta<typeof PermissionModal>;

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

export const ComplexToolInput: Story = {
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
      options: {
        shell: '/bin/bash',
        inheritEnv: true,
        captureOutput: true,
      },
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
        story: 'When permission is null, the modal is hidden and nothing is rendered.',
      },
    },
  },
};
