import type { Meta, StoryObj } from '@storybook/react';

import type { ChatMessage, ClaudeMessage } from '@/lib/claude-types';

import { MessageList } from './message-list';

// =============================================================================
// Fixtures
// =============================================================================

function createUserMessage(id: string, text: string): ChatMessage {
  return {
    id,
    source: 'user',
    text,
    timestamp: new Date().toISOString(),
  };
}

function createAssistantTextMessage(id: string, text: string): ChatMessage {
  return {
    id,
    source: 'claude',
    message: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    },
    timestamp: new Date().toISOString(),
  };
}

function createToolUseMessage(
  id: string,
  toolName: string,
  input: Record<string, unknown>
): ChatMessage {
  const claudeMessage: ClaudeMessage = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: `tool-${id}`,
        name: toolName,
        input,
      },
    },
  };
  return {
    id,
    source: 'claude',
    message: claudeMessage,
    timestamp: new Date().toISOString(),
  };
}

function createToolResultMessage(
  id: string,
  toolUseId: string,
  content: string,
  isError = false
): ChatMessage {
  const claudeMessage: ClaudeMessage = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      },
    },
  };
  return {
    id,
    source: 'claude',
    message: claudeMessage,
    timestamp: new Date().toISOString(),
  };
}

function createErrorMessage(id: string, error: string): ChatMessage {
  return {
    id,
    source: 'claude',
    message: {
      type: 'error',
      error,
    },
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Story Setup
// =============================================================================

const meta: Meta<typeof MessageList> = {
  title: 'Chat/MessageList',
  component: MessageList,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    running: {
      control: 'boolean',
      description: 'Whether a request is currently running (shows streaming indicator)',
    },
  },
  decorators: [
    (Story) => (
      <div className="h-[500px] w-full max-w-3xl mx-auto border rounded-lg overflow-hidden">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Stories
// =============================================================================

export const Empty: Story = {
  args: {
    messages: [],
  },
};

export const SingleUserMessage: Story = {
  args: {
    messages: [createUserMessage('1', 'Hello! How can you help me with my code?')],
  },
};

export const SingleAssistantMessage: Story = {
  args: {
    messages: [
      createAssistantTextMessage(
        '1',
        "Hello! I'm here to help you with your code. I can help you with:\n\n- Writing and editing code\n- Debugging issues\n- Explaining code concepts\n- Reviewing code for improvements\n\nWhat would you like to work on today?"
      ),
    ],
  },
};

export const Conversation: Story = {
  args: {
    messages: [
      createUserMessage('1', 'Can you help me create a new React component?'),
      createAssistantTextMessage(
        '2',
        "Of course! I'd be happy to help you create a React component. Could you tell me more about what kind of component you need? For example:\n\n- What should the component be called?\n- What props should it accept?\n- What functionality should it have?"
      ),
      createUserMessage(
        '3',
        'I need a Button component that accepts a label, onClick handler, and can be disabled.'
      ),
      createAssistantTextMessage(
        '4',
        'Great! Here\'s a simple Button component that meets your requirements:\n\n```tsx\ninterface ButtonProps {\n  label: string;\n  onClick: () => void;\n  disabled?: boolean;\n}\n\nexport function Button({ label, onClick, disabled = false }: ButtonProps) {\n  return (\n    <button\n      onClick={onClick}\n      disabled={disabled}\n      className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50"\n    >\n      {label}\n    </button>\n  );\n}\n```\n\nWould you like me to add any additional features?'
      ),
    ],
  },
};

export const WithToolCalls: Story = {
  args: {
    messages: [
      createUserMessage('1', 'Can you read the contents of package.json?'),
      createToolUseMessage('2', 'Read', { file_path: '/project/package.json' }),
      createToolResultMessage(
        '3',
        'tool-2',
        JSON.stringify(
          {
            name: 'my-project',
            version: '1.0.0',
            dependencies: {
              react: '^18.0.0',
              typescript: '^5.0.0',
            },
          },
          null,
          2
        )
      ),
      createAssistantTextMessage(
        '4',
        "I've read your package.json file. Your project is using:\n\n- React 18.0.0\n- TypeScript 5.0.0\n\nIs there anything specific you'd like to know about your dependencies?"
      ),
    ],
  },
};

export const WithErrors: Story = {
  args: {
    messages: [
      createUserMessage('1', 'Can you read a file that does not exist?'),
      createToolUseMessage('2', 'Read', { file_path: '/project/nonexistent.txt' }),
      createToolResultMessage(
        '3',
        'tool-2',
        'Error: File not found: /project/nonexistent.txt',
        true
      ),
      createErrorMessage('4', 'Failed to read file: The specified file does not exist.'),
    ],
  },
};

export const Running: Story = {
  args: {
    messages: [
      createUserMessage('1', 'Can you analyze my project structure?'),
      createAssistantTextMessage('2', 'Let me analyze your project structure...'),
    ],
    running: true,
  },
};

export const LongConversation: Story = {
  args: {
    messages: [
      createUserMessage('1', 'I need help with a complex refactoring task.'),
      createAssistantTextMessage(
        '2',
        "I'd be happy to help with refactoring. What would you like to refactor?"
      ),
      createUserMessage('3', 'I want to split my monolithic component into smaller pieces.'),
      createAssistantTextMessage(
        '4',
        'Great idea! Breaking down monolithic components improves maintainability. Let me first look at your component.'
      ),
      createToolUseMessage('5', 'Read', { file_path: '/src/components/Dashboard.tsx' }),
      createToolResultMessage(
        '6',
        'tool-5',
        "// Dashboard.tsx\nimport React from 'react';\n\nexport function Dashboard() {\n  // ... 500 lines of code\n  return <div>Dashboard</div>;\n}"
      ),
      createAssistantTextMessage(
        '7',
        'I see that your Dashboard component is quite large. I recommend splitting it into these smaller components:\n\n1. **DashboardHeader** - Navigation and user info\n2. **DashboardSidebar** - Menu items\n3. **DashboardContent** - Main content area\n4. **DashboardWidgets** - Individual widget components\n\nShall I start with one of these?'
      ),
      createUserMessage('8', "Let's start with the DashboardHeader."),
      createAssistantTextMessage('9', "I'll create the DashboardHeader component now."),
      createToolUseMessage('10', 'Write', {
        file_path: '/src/components/DashboardHeader.tsx',
        content: '// DashboardHeader component...',
      }),
      createToolResultMessage('11', 'tool-10', 'File written successfully'),
      createAssistantTextMessage(
        '12',
        "I've created the DashboardHeader component. Would you like me to continue with the other components?"
      ),
      createUserMessage('13', 'Yes, please continue with DashboardSidebar.'),
      createAssistantTextMessage('14', 'Creating the DashboardSidebar component...'),
      createToolUseMessage('15', 'Write', {
        file_path: '/src/components/DashboardSidebar.tsx',
        content: '// DashboardSidebar component...',
      }),
      createToolResultMessage('16', 'tool-15', 'File written successfully'),
      createAssistantTextMessage(
        '17',
        'Done! Both header and sidebar components are now created. The refactoring is progressing well.'
      ),
    ],
  },
};
