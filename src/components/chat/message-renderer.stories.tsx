import type { Meta, StoryObj } from '@storybook/react';

import type { ChatMessage, ClaudeMessage } from '@/lib/claude-types';

import { MessageRenderer } from './message-renderer';

// =============================================================================
// Fixtures
// =============================================================================

function createUserMessage(text: string): ChatMessage {
  return {
    id: 'user-1',
    source: 'user',
    text,
    timestamp: new Date().toISOString(),
  };
}

function createAssistantTextMessage(text: string): ChatMessage {
  return {
    id: 'assistant-1',
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

function createStreamEventTextDelta(text: string): ChatMessage {
  const claudeMessage: ClaudeMessage = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text,
      },
    },
  };
  return {
    id: 'stream-1',
    source: 'claude',
    message: claudeMessage,
    timestamp: new Date().toISOString(),
  };
}

function createToolUseMessage(toolName: string, input: Record<string, unknown>): ChatMessage {
  const claudeMessage: ClaudeMessage = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'tool-use-1',
        name: toolName,
        input,
      },
    },
  };
  return {
    id: 'tool-use-1',
    source: 'claude',
    message: claudeMessage,
    timestamp: new Date().toISOString(),
  };
}

function createToolResultMessage(content: string, isError = false): ChatMessage {
  const claudeMessage: ClaudeMessage = {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_result',
        tool_use_id: 'tool-use-1',
        content,
        is_error: isError,
      },
    },
  };
  return {
    id: 'tool-result-1',
    source: 'claude',
    message: claudeMessage,
    timestamp: new Date().toISOString(),
  };
}

function createResultMessage(): ChatMessage {
  return {
    id: 'result-1',
    source: 'claude',
    message: {
      type: 'result',
      usage: {
        input_tokens: 1250,
        output_tokens: 487,
      },
      duration_ms: 4523,
      total_cost_usd: 0.0234,
      num_turns: 3,
    },
    timestamp: new Date().toISOString(),
  };
}

function createErrorMessage(error: string): ChatMessage {
  return {
    id: 'error-1',
    source: 'claude',
    message: {
      type: 'error',
      error,
    },
    timestamp: new Date().toISOString(),
  };
}

function createSystemMessage(subtype: string, extras?: Partial<ClaudeMessage>): ChatMessage {
  return {
    id: 'system-1',
    source: 'claude',
    message: {
      type: 'system',
      subtype,
      ...extras,
    },
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Story Setup
// =============================================================================

const meta: Meta<typeof MessageRenderer> = {
  title: 'Chat/MessageRenderer',
  component: MessageRenderer,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    isStreaming: {
      control: 'boolean',
      description: 'Whether to show the streaming cursor',
    },
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl p-4">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// User Message Stories
// =============================================================================

export const UserMessage: Story = {
  args: {
    message: createUserMessage('Hello! How can you help me with my code?'),
  },
};

// =============================================================================
// Assistant Message Stories
// =============================================================================

export const AssistantText: Story = {
  args: {
    message: createAssistantTextMessage(
      "Hello! I'm here to help you with your code. What would you like to work on today?"
    ),
  },
};

export const AssistantWithCode: Story = {
  args: {
    message: createAssistantTextMessage(
      'Here\'s a simple React component:\n\n```tsx\ninterface ButtonProps {\n  label: string;\n  onClick: () => void;\n  disabled?: boolean;\n}\n\nexport function Button({ label, onClick, disabled = false }: ButtonProps) {\n  return (\n    <button\n      onClick={onClick}\n      disabled={disabled}\n      className="px-4 py-2 bg-blue-500 text-white rounded"\n    >\n      {label}\n    </button>\n  );\n}\n```\n\nThis component accepts a label, onClick handler, and optional disabled prop.'
    ),
  },
};

// =============================================================================
// Tool Use Stories
// =============================================================================

export const ToolUseRead: Story = {
  args: {
    message: createToolUseMessage('Read', {
      file_path: '/src/components/Button.tsx',
    }),
  },
};

export const ToolUseWrite: Story = {
  args: {
    message: createToolUseMessage('Write', {
      file_path: '/src/components/NewComponent.tsx',
      content:
        "import React from 'react';\n\nexport function NewComponent() {\n  return <div>New Component</div>;\n}",
    }),
  },
};

export const ToolUseEdit: Story = {
  args: {
    message: createToolUseMessage('Edit', {
      file_path: '/src/components/Button.tsx',
      old_string: 'bg-blue-500',
      new_string: 'bg-indigo-600',
    }),
  },
};

export const ToolUseBash: Story = {
  args: {
    message: createToolUseMessage('Bash', {
      command: 'npm install lodash @types/lodash',
      description: 'Install lodash and its TypeScript types',
    }),
  },
};

// =============================================================================
// Tool Result Stories
// =============================================================================

export const ToolResultSuccess: Story = {
  args: {
    message: createToolResultMessage(
      'import React from \'react\';\n\ninterface ButtonProps {\n  label: string;\n  onClick: () => void;\n}\n\nexport function Button({ label, onClick }: ButtonProps) {\n  return (\n    <button onClick={onClick} className="btn">\n      {label}\n    </button>\n  );\n}'
    ),
  },
};

export const ToolResultError: Story = {
  args: {
    message: createToolResultMessage(
      'Error: File not found: /src/components/NonExistent.tsx',
      true
    ),
  },
};

// =============================================================================
// Stream Event Stories
// =============================================================================

export const StreamEventDelta: Story = {
  args: {
    message: createStreamEventTextDelta('I am currently analyzing your code...'),
    isStreaming: true,
  },
};

// =============================================================================
// Result & System Message Stories
// =============================================================================

export const ResultMessage: Story = {
  args: {
    message: createResultMessage(),
  },
};

export const ErrorMessage: Story = {
  args: {
    message: createErrorMessage(
      'Failed to complete the request. The API rate limit has been exceeded. Please try again in a few minutes.'
    ),
  },
};

export const SystemMessage: Story = {
  args: {
    message: createSystemMessage('init', {
      model: 'claude-opus-4-5-20251101',
      cwd: '/Users/developer/my-project',
      tools: [
        { name: 'Read' },
        { name: 'Write' },
        { name: 'Edit' },
        { name: 'Bash' },
        { name: 'Glob' },
        { name: 'Grep' },
      ],
    }),
  },
};

// =============================================================================
// Composite Story
// =============================================================================

export const AllMessageTypes: Story = {
  args: {
    message: createUserMessage('Example message'),
  },
  render: () => (
    <div className="flex flex-col gap-6 w-full max-w-2xl">
      <div>
        <h3 className="text-sm font-medium mb-2 text-muted-foreground">User Message</h3>
        <MessageRenderer message={createUserMessage('Can you help me with React?')} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-muted-foreground">Assistant Text</h3>
        <MessageRenderer
          message={createAssistantTextMessage("Of course! I'd be happy to help with React.")}
        />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-muted-foreground">Tool Use (Read)</h3>
        <MessageRenderer message={createToolUseMessage('Read', { file_path: '/src/App.tsx' })} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-muted-foreground">Tool Result (Success)</h3>
        <MessageRenderer
          message={createToolResultMessage('export function App() { return <div>Hello</div>; }')}
        />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-muted-foreground">Tool Result (Error)</h3>
        <MessageRenderer message={createToolResultMessage('Error: Permission denied', true)} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-muted-foreground">Stream Delta (Streaming)</h3>
        <MessageRenderer
          message={createStreamEventTextDelta('Analyzing your code')}
          isStreaming={true}
        />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-muted-foreground">Result Stats</h3>
        <MessageRenderer message={createResultMessage()} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-muted-foreground">Error Message</h3>
        <MessageRenderer message={createErrorMessage('API rate limit exceeded')} />
      </div>

      <div>
        <h3 className="text-sm font-medium mb-2 text-muted-foreground">System Message</h3>
        <MessageRenderer
          message={createSystemMessage('init', {
            model: 'claude-opus-4-5-20251101',
            cwd: '/project',
            tools: [{ name: 'Read' }, { name: 'Write' }],
          })}
        />
      </div>
    </div>
  ),
};
