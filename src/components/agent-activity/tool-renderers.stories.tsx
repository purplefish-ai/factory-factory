import type { Meta, StoryObj } from '@storybook/react';
import {
  SAMPLE_BASH_COMMANDS,
  SAMPLE_BASH_OUTPUTS,
  SAMPLE_FILE_CONTENTS,
  SAMPLE_FILE_PATHS,
} from '@/lib/claude-fixtures';
import type { ChatMessage, ClaudeMessage, ToolSequence } from '@/lib/claude-types';
import { ToolCallGroupRenderer, ToolInfoRenderer, ToolSequenceGroup } from './tool-renderers';
import type { ToolCallInfo } from './types';

// =============================================================================
// Helper Functions for Creating Messages
// =============================================================================

function createToolUseClaudeMessage(
  toolName: string,
  input: Record<string, unknown>,
  toolId = `toolu_${Date.now()}`
): ClaudeMessage {
  return {
    type: 'stream_event',
    timestamp: new Date().toISOString(),
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input,
      },
    },
  };
}

function createToolResultClaudeMessage(
  toolUseId: string,
  content: string,
  isError = false
): ClaudeMessage {
  return {
    type: 'stream_event',
    timestamp: new Date().toISOString(),
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
}

// =============================================================================
// ToolInfoRenderer Meta
// =============================================================================

const meta = {
  title: 'AgentActivity/ToolRenderers',
  component: ToolInfoRenderer,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    defaultOpen: {
      control: 'boolean',
      description: 'Whether the collapsible is open by default',
    },
  },
} satisfies Meta<typeof ToolInfoRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

// =============================================================================
// Tool Use Stories - Read Tool
// =============================================================================

export const ToolUseRead: Story = {
  args: {
    message: createToolUseClaudeMessage('Read', {
      file_path: SAMPLE_FILE_PATHS.typescript,
    }),
    defaultOpen: true,
  },
};

export const ToolUseReadWithOffset: Story = {
  args: {
    message: createToolUseClaudeMessage('Read', {
      file_path: SAMPLE_FILE_PATHS.typescript,
      offset: 10,
      limit: 50,
    }),
    defaultOpen: true,
  },
};

// =============================================================================
// Tool Use Stories - Write Tool
// =============================================================================

export const ToolUseWrite: Story = {
  args: {
    message: createToolUseClaudeMessage('Write', {
      file_path: SAMPLE_FILE_PATHS.typescript,
      content: SAMPLE_FILE_CONTENTS.typescript,
    }),
    defaultOpen: true,
  },
};

export const ToolUseWriteShort: Story = {
  args: {
    message: createToolUseClaudeMessage('Write', {
      file_path: '/Users/developer/project/.env',
      content: 'DATABASE_URL=postgres://localhost:5432/mydb\nAPI_KEY=secret',
    }),
    defaultOpen: true,
  },
};

// =============================================================================
// Tool Use Stories - Edit Tool
// =============================================================================

export const ToolUseEdit: Story = {
  args: {
    message: createToolUseClaudeMessage('Edit', {
      file_path: SAMPLE_FILE_PATHS.typescript,
      old_string: "variant = 'primary'",
      new_string: "variant = 'secondary'",
    }),
    defaultOpen: true,
  },
};

export const ToolUseEditMultiLine: Story = {
  args: {
    message: createToolUseClaudeMessage('Edit', {
      file_path: SAMPLE_FILE_PATHS.typescript,
      old_string: `interface ButtonProps {
  label: string;
  onClick: () => void;
}`,
      new_string: `interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}`,
    }),
    defaultOpen: true,
  },
};

// =============================================================================
// Tool Use Stories - Bash Tool
// =============================================================================

export const ToolUseBash: Story = {
  args: {
    message: createToolUseClaudeMessage('Bash', {
      command: SAMPLE_BASH_COMMANDS.gitStatus,
      description: 'Check git repository status',
    }),
    defaultOpen: true,
  },
};

export const ToolUseBashComplex: Story = {
  args: {
    message: createToolUseClaudeMessage('Bash', {
      command: 'find . -name "*.ts" -type f | xargs grep -l "export function" | head -20',
      description: 'Find TypeScript files with exported functions',
    }),
    defaultOpen: true,
  },
};

export const ToolUseBashNoDescription: Story = {
  args: {
    message: createToolUseClaudeMessage('Bash', {
      command: 'npm install',
    }),
    defaultOpen: true,
  },
};

// =============================================================================
// Tool Use Stories - Glob Tool
// =============================================================================

export const ToolUseGlob: Story = {
  args: {
    message: createToolUseClaudeMessage('Glob', {
      pattern: '**/*.tsx',
      path: '/Users/developer/project/src',
    }),
    defaultOpen: true,
  },
};

export const ToolUseGlobNoPath: Story = {
  args: {
    message: createToolUseClaudeMessage('Glob', {
      pattern: '**/Button*.{ts,tsx}',
    }),
    defaultOpen: true,
  },
};

// =============================================================================
// Tool Use Stories - Grep Tool
// =============================================================================

export const ToolUseGrep: Story = {
  args: {
    message: createToolUseClaudeMessage('Grep', {
      pattern: 'export function',
      path: '/Users/developer/project/src',
      glob: '*.ts',
    }),
    defaultOpen: true,
  },
};

export const ToolUseGrepRegex: Story = {
  args: {
    message: createToolUseClaudeMessage('Grep', {
      pattern: 'use[A-Z][a-zA-Z]+\\(',
      path: '/Users/developer/project/src/hooks',
    }),
    defaultOpen: true,
  },
};

// =============================================================================
// Tool Use Stories - Unknown Tool
// =============================================================================

export const ToolUseUnknown: Story = {
  args: {
    message: createToolUseClaudeMessage('CustomTool', {
      param1: 'value1',
      param2: 123,
      nested: { key: 'value' },
    }),
    defaultOpen: true,
  },
};

// =============================================================================
// Tool Result Stories
// =============================================================================

export const ToolResultSuccess: Story = {
  args: {
    message: createToolResultClaudeMessage('toolu_123', SAMPLE_FILE_CONTENTS.typescript),
    defaultOpen: true,
  },
};

export const ToolResultError: Story = {
  args: {
    message: createToolResultClaudeMessage(
      'toolu_456',
      "Error: ENOENT: no such file or directory, open '/nonexistent/path.ts'",
      true
    ),
    defaultOpen: true,
  },
};

export const ToolResultLongOutput: Story = {
  args: {
    message: createToolResultClaudeMessage(
      'toolu_789',
      SAMPLE_BASH_OUTPUTS.npmInstall +
        '\n\n' +
        'Additional packages installed:\n' +
        '  - typescript@5.0.0\n'.repeat(50)
    ),
    defaultOpen: true,
  },
};

export const ToolResultJson: Story = {
  args: {
    message: createToolResultClaudeMessage(
      'toolu_json',
      JSON.stringify(
        {
          files: [
            '/Users/developer/project/src/components/Button.tsx',
            '/Users/developer/project/src/components/Input.tsx',
            '/Users/developer/project/src/components/Card.tsx',
          ],
          count: 3,
        },
        null,
        2
      )
    ),
    defaultOpen: true,
  },
};

export const ToolResultBashSuccess: Story = {
  args: {
    message: createToolResultClaudeMessage('toolu_bash', SAMPLE_BASH_OUTPUTS.npmTest),
    defaultOpen: true,
  },
};

// =============================================================================
// Collapsed States
// =============================================================================

export const ToolUseCollapsed: Story = {
  args: {
    message: createToolUseClaudeMessage('Read', {
      file_path: SAMPLE_FILE_PATHS.typescript,
    }),
    defaultOpen: false,
  },
};

export const ToolResultCollapsed: Story = {
  args: {
    message: createToolResultClaudeMessage('toolu_123', SAMPLE_FILE_CONTENTS.typescript),
    defaultOpen: false,
  },
};

// =============================================================================
// ToolCallGroupRenderer Stories
// =============================================================================

const createToolCallInfo = (
  name: string,
  input: Record<string, unknown>,
  result?: { content: string; isError: boolean }
): ToolCallInfo => ({
  id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
  name,
  input,
  result: result ? { content: result.content, isError: result.isError } : undefined,
  timestamp: new Date().toISOString(),
});

export const ToolCallGroup: StoryObj<typeof ToolCallGroupRenderer> = {
  render: () => (
    <ToolCallGroupRenderer
      defaultOpen={true}
      toolCalls={[
        createToolCallInfo(
          'Glob',
          { pattern: '**/*.tsx', path: '/Users/developer/project' },
          {
            content: JSON.stringify(
              [
                '/Users/developer/project/src/components/Button.tsx',
                '/Users/developer/project/src/components/Input.tsx',
              ],
              null,
              2
            ),
            isError: false,
          }
        ),
        createToolCallInfo(
          'Read',
          { file_path: '/Users/developer/project/src/components/Button.tsx' },
          { content: SAMPLE_FILE_CONTENTS.typescript, isError: false }
        ),
        createToolCallInfo(
          'Read',
          { file_path: '/Users/developer/project/src/components/Input.tsx' },
          { content: 'export function Input() { return <input />; }', isError: false }
        ),
      ]}
    />
  ),
};

export const ToolCallGroupWithErrors: StoryObj<typeof ToolCallGroupRenderer> = {
  render: () => (
    <ToolCallGroupRenderer
      defaultOpen={true}
      toolCalls={[
        createToolCallInfo(
          'Read',
          { file_path: '/Users/developer/project/src/valid.ts' },
          { content: 'export const valid = true;', isError: false }
        ),
        createToolCallInfo(
          'Read',
          { file_path: '/Users/developer/project/src/nonexistent.ts' },
          { content: 'Error: ENOENT: no such file or directory', isError: true }
        ),
        createToolCallInfo(
          'Bash',
          { command: 'npm test' },
          { content: SAMPLE_BASH_OUTPUTS.npmTest, isError: false }
        ),
      ]}
    />
  ),
};

export const ToolCallGroupPending: StoryObj<typeof ToolCallGroupRenderer> = {
  render: () => (
    <ToolCallGroupRenderer
      defaultOpen={true}
      toolCalls={[
        createToolCallInfo(
          'Read',
          { file_path: '/Users/developer/project/src/file1.ts' },
          { content: 'export const one = 1;', isError: false }
        ),
        createToolCallInfo('Read', { file_path: '/Users/developer/project/src/file2.ts' }),
        createToolCallInfo('Read', { file_path: '/Users/developer/project/src/file3.ts' }),
      ]}
    />
  ),
};

export const ToolCallGroupCollapsed: StoryObj<typeof ToolCallGroupRenderer> = {
  render: () => (
    <ToolCallGroupRenderer
      defaultOpen={false}
      toolCalls={[
        createToolCallInfo(
          'Glob',
          { pattern: '**/*.tsx' },
          { content: '["/path/to/file.tsx"]', isError: false }
        ),
        createToolCallInfo(
          'Read',
          { file_path: '/path/to/file.tsx' },
          { content: 'export function Component() {}', isError: false }
        ),
      ]}
    />
  ),
};

export const ToolCallGroupEmpty: StoryObj<typeof ToolCallGroupRenderer> = {
  render: () => <ToolCallGroupRenderer defaultOpen={true} toolCalls={[]} />,
};

export const ToolCallGroupSingle: StoryObj<typeof ToolCallGroupRenderer> = {
  render: () => (
    <ToolCallGroupRenderer
      defaultOpen={true}
      toolCalls={[
        createToolCallInfo(
          'Bash',
          { command: 'git status', description: 'Check git status' },
          { content: SAMPLE_BASH_OUTPUTS.gitStatus, isError: false }
        ),
      ]}
    />
  ),
};

// =============================================================================
// Composite Stories
// =============================================================================

const defaultMessage = createToolUseClaudeMessage('Read', {
  file_path: SAMPLE_FILE_PATHS.typescript,
});

export const AllToolTypes: Story = {
  args: {
    message: defaultMessage,
    defaultOpen: true,
  },
  render: () => (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Read Tool</h3>
        <ToolInfoRenderer
          message={createToolUseClaudeMessage('Read', {
            file_path: SAMPLE_FILE_PATHS.typescript,
          })}
          defaultOpen={true}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Write Tool</h3>
        <ToolInfoRenderer
          message={createToolUseClaudeMessage('Write', {
            file_path: '/Users/developer/project/new-file.ts',
            content: 'export const newFile = true;',
          })}
          defaultOpen={true}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Edit Tool</h3>
        <ToolInfoRenderer
          message={createToolUseClaudeMessage('Edit', {
            file_path: SAMPLE_FILE_PATHS.typescript,
            old_string: 'const',
            new_string: 'let',
          })}
          defaultOpen={true}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Bash Tool</h3>
        <ToolInfoRenderer
          message={createToolUseClaudeMessage('Bash', {
            command: 'npm test',
            description: 'Run tests',
          })}
          defaultOpen={true}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Glob Tool</h3>
        <ToolInfoRenderer
          message={createToolUseClaudeMessage('Glob', {
            pattern: '**/*.tsx',
            path: '/Users/developer/project',
          })}
          defaultOpen={true}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Grep Tool</h3>
        <ToolInfoRenderer
          message={createToolUseClaudeMessage('Grep', {
            pattern: 'export function',
            path: '/Users/developer/project/src',
          })}
          defaultOpen={true}
        />
      </div>
    </div>
  ),
};

export const ToolResultStates: Story = {
  args: {
    message: defaultMessage,
    defaultOpen: true,
  },
  render: () => (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-2">Success Result</h3>
        <ToolInfoRenderer
          message={createToolResultClaudeMessage(
            'toolu_1',
            `File read successfully:\n${SAMPLE_FILE_CONTENTS.typescript.slice(0, 200)}`
          )}
          defaultOpen={true}
        />
      </div>
      <div>
        <h3 className="text-sm font-medium mb-2">Error Result</h3>
        <ToolInfoRenderer
          message={createToolResultClaudeMessage('toolu_2', 'Error: Permission denied', true)}
          defaultOpen={true}
        />
      </div>
    </div>
  ),
};

// =============================================================================
// ToolSequenceGroup Stories
// =============================================================================

/**
 * Helper to create a ChatMessage from a tool use.
 */
function createToolUseChatMessage(
  toolName: string,
  input: Record<string, unknown>,
  toolId = `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
): ChatMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    source: 'claude',
    message: createToolUseClaudeMessage(toolName, input, toolId),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Helper to create a ChatMessage from a tool result.
 */
function createToolResultChatMessage(
  toolUseId: string,
  content: string,
  isError = false
): ChatMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    source: 'claude',
    message: createToolResultClaudeMessage(toolUseId, content, isError),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Creates a ToolSequence for testing.
 */
function createToolSequence(
  tools: Array<{ name: string; input: Record<string, unknown>; result?: string; isError?: boolean }>
): ToolSequence {
  const messages: ChatMessage[] = [];
  const toolNames: string[] = [];
  const statuses: Array<'pending' | 'success' | 'error'> = [];
  const pairedCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    status: 'pending' | 'success' | 'error';
    result?: { content: string; isError: boolean };
  }> = [];

  for (const tool of tools) {
    const toolId = `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    messages.push(createToolUseChatMessage(tool.name, tool.input, toolId));
    toolNames.push(tool.name);

    const status: 'pending' | 'success' | 'error' =
      tool.result !== undefined ? (tool.isError ? 'error' : 'success') : 'pending';
    statuses.push(status);

    pairedCalls.push({
      id: toolId,
      name: tool.name,
      input: tool.input,
      status,
      result:
        tool.result !== undefined
          ? { content: tool.result, isError: tool.isError ?? false }
          : undefined,
    });

    if (tool.result !== undefined) {
      messages.push(createToolResultChatMessage(toolId, tool.result, tool.isError));
    }
  }

  return {
    type: 'tool_sequence',
    id: `tool-seq-${Date.now()}`,
    pairedCalls,
    messages,
    toolNames,
    statuses,
  };
}

export const ToolSequenceGroupBasic: StoryObj<typeof ToolSequenceGroup> = {
  render: () => (
    <ToolSequenceGroup
      defaultOpen={false}
      sequence={createToolSequence([
        {
          name: 'Read',
          input: { file_path: '/project/src/Button.tsx' },
          result: SAMPLE_FILE_CONTENTS.typescript,
        },
        {
          name: 'Read',
          input: { file_path: '/project/src/Input.tsx' },
          result: 'export function Input() {}',
        },
        { name: 'Bash', input: { command: 'npm test' }, result: SAMPLE_BASH_OUTPUTS.npmTest },
      ])}
    />
  ),
};

export const ToolSequenceGroupExpanded: StoryObj<typeof ToolSequenceGroup> = {
  render: () => (
    <ToolSequenceGroup
      defaultOpen={true}
      sequence={createToolSequence([
        {
          name: 'Read',
          input: { file_path: '/project/src/Button.tsx' },
          result: SAMPLE_FILE_CONTENTS.typescript,
        },
        {
          name: 'Edit',
          input: { file_path: '/project/src/Button.tsx', old_string: 'const', new_string: 'let' },
          result: 'File edited successfully',
        },
        { name: 'Bash', input: { command: 'npm test' }, result: SAMPLE_BASH_OUTPUTS.npmTest },
      ])}
    />
  ),
};

export const ToolSequenceGroupWithErrors: StoryObj<typeof ToolSequenceGroup> = {
  render: () => (
    <ToolSequenceGroup
      defaultOpen={false}
      sequence={createToolSequence([
        {
          name: 'Read',
          input: { file_path: '/project/src/valid.ts' },
          result: 'export const valid = true;',
        },
        {
          name: 'Read',
          input: { file_path: '/project/src/missing.ts' },
          result: 'Error: ENOENT: no such file',
          isError: true,
        },
        {
          name: 'Read',
          input: { file_path: '/project/src/another.ts' },
          result: 'export const another = 42;',
        },
      ])}
    />
  ),
};

export const ToolSequenceGroupPending: StoryObj<typeof ToolSequenceGroup> = {
  render: () => (
    <ToolSequenceGroup
      defaultOpen={false}
      sequence={createToolSequence([
        { name: 'Read', input: { file_path: '/project/src/file1.ts' }, result: 'content 1' },
        { name: 'Read', input: { file_path: '/project/src/file2.ts' } }, // No result = pending
        { name: 'Read', input: { file_path: '/project/src/file3.ts' } }, // No result = pending
      ])}
    />
  ),
};

export const ToolSequenceGroupManyTools: StoryObj<typeof ToolSequenceGroup> = {
  render: () => (
    <ToolSequenceGroup
      defaultOpen={false}
      sequence={createToolSequence([
        { name: 'Glob', input: { pattern: '**/*.ts' }, result: '["/a.ts", "/b.ts"]' },
        { name: 'Read', input: { file_path: '/a.ts' }, result: 'export const a = 1;' },
        { name: 'Read', input: { file_path: '/b.ts' }, result: 'export const b = 2;' },
        {
          name: 'Edit',
          input: { file_path: '/a.ts', old_string: '1', new_string: '2' },
          result: 'ok',
        },
        { name: 'Bash', input: { command: 'npm test' }, result: 'pass' },
        { name: 'Bash', input: { command: 'npm build' }, result: 'done' },
      ])}
    />
  ),
};
