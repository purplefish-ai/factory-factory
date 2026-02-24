import { FileCode, Zap } from 'lucide-react';
import type { ReactElement } from 'react';
import { memo } from 'react';
import type { Todo } from '@/components/chat/use-todo-tracker';
import { TodoItem } from '@/components/shared';
import type { ToolResultContentValue } from '@/lib/chat-protocol';
import { calculateTodoProgress } from '@/lib/todo-utils';
import {
  isCodexFileChangeToolName,
  parseCodexFileChangeToolInput,
  serializeUnknownPayload,
} from './file-change-parser';
import { CodexFileChangeRenderer } from './file-change-renderer';
import { extractCommandPreviewFromInput, isRunLikeToolName } from './tool-display-utils';
import {
  isWebSearchToolName,
  parseWebSearchToolInput,
  parseWebSearchToolResult,
} from './web-search-parser';

// =============================================================================
// Constants
// =============================================================================

const TOOL_INPUT_CONTENT_TRUNCATE = 5000;
const TOOL_INPUT_DIFF_TRUNCATE = 2000;

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n... (truncated)`;
}

// =============================================================================
// Helper Components
// =============================================================================

export const FilePathDisplay = memo(function FilePathDisplay({ path }: { path: string }) {
  if (!path) {
    return null;
  }

  // Extract filename from path
  const parts = path.split('/');
  const filename = parts[parts.length - 1];
  const directory = parts.slice(0, -1).join('/');

  return (
    <div className="flex items-center gap-1 text-sm min-w-0">
      <FileCode className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground truncate">{directory}/</span>
      <span className="font-medium shrink-0">{filename}</span>
    </div>
  );
});

// =============================================================================
// Task Tool Renderer
// =============================================================================

/**
 * Renders a Task tool (subagent launch) with improved formatting
 */
const TaskToolRenderer = memo(function TaskToolRenderer({
  input,
}: {
  input: Record<string, unknown>;
}) {
  const subagentType = input.subagent_type as string | undefined;
  const description = input.description as string | undefined;
  const prompt = input.prompt as string | undefined;

  return (
    <div className="space-y-2 w-0 min-w-full">
      <div className="flex items-center gap-1.5">
        <Zap className="h-4 w-4 shrink-0 text-primary" />
        <span className="font-semibold text-sm">
          {subagentType ? `${subagentType} Agent` : 'Subagent'}
        </span>
      </div>
      {description && <div className="text-xs text-muted-foreground italic">{description}</div>}
      {prompt && (
        <div className="rounded bg-muted/50 px-2 py-1.5">
          <div className="text-[10px] font-medium text-muted-foreground mb-0.5">Task</div>
          <pre className="text-xs whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto">
            {prompt}
          </pre>
        </div>
      )}
      {/* Show other parameters if present */}
      {Object.keys(input).filter((k) => !['subagent_type', 'description', 'prompt'].includes(k))
        .length > 0 && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
            Additional parameters
          </summary>
          <pre className="mt-1 text-xs overflow-x-auto rounded bg-muted px-1.5 py-1">
            {JSON.stringify(
              Object.fromEntries(
                Object.entries(input).filter(
                  ([k]) => !['subagent_type', 'description', 'prompt'].includes(k)
                )
              ),
              null,
              2
            )}
          </pre>
        </details>
      )}
    </div>
  );
});

// =============================================================================
// TodoWrite Tool Renderer
// =============================================================================

/**
 * Renders TodoWrite tool with visual task list and progress bar
 */
const TodoWriteToolRenderer = memo(function TodoWriteToolRenderer({
  input,
}: {
  input: Record<string, unknown>;
}) {
  const todos = input.todos as Todo[] | undefined;

  if (!todos || todos.length === 0) {
    return <div className="text-xs text-muted-foreground">No todos</div>;
  }

  const { completedCount, totalCount, progressPercent } = calculateTodoProgress(todos);

  return (
    <div className="space-y-2 w-0 min-w-full">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">
          Task List ({completedCount}/{totalCount})
        </span>
        <span className="text-xs text-muted-foreground">{progressPercent}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      <div className="space-y-1.5">
        {todos.map((todo, index) => (
          <TodoItem key={`${todo.content}-${index}`} todo={todo} />
        ))}
      </div>
    </div>
  );
});

// =============================================================================
// Run Tool Renderer
// =============================================================================

/**
 * Renders Run tool calls with command-focused formatting.
 */
const RunToolRenderer = memo(function RunToolRenderer({
  input,
}: {
  input: Record<string, unknown>;
}) {
  const commandPreview = extractCommandPreviewFromInput(input);
  const commandValue = input.command;
  const invocationArgs =
    Array.isArray(commandValue) && commandValue.every((arg) => typeof arg === 'string')
      ? commandValue
      : null;
  const fallback =
    commandPreview ??
    (typeof commandValue === 'string'
      ? commandValue
      : commandValue != null
        ? JSON.stringify(commandValue, null, 2)
        : '(no command)');

  const additionalParams = Object.fromEntries(
    Object.entries(input).filter(([key]) => !['command', 'description', 'cwd'].includes(key))
  );

  return (
    <div className="space-y-1 w-0 min-w-full">
      <div className="rounded bg-muted px-1.5 py-1 font-mono">
        <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words">
          {truncateContent(fallback, TOOL_INPUT_CONTENT_TRUNCATE)}
        </pre>
      </div>

      {typeof input.cwd === 'string' && input.cwd.length > 0 && (
        <div className="text-[10px] text-muted-foreground">cwd: {input.cwd}</div>
      )}

      {typeof input.description === 'string' && input.description.length > 0 && (
        <div className="text-[10px] text-muted-foreground">{input.description}</div>
      )}

      {invocationArgs && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
            Invocation args
          </summary>
          <pre className="mt-1 text-xs overflow-x-auto rounded bg-muted px-1.5 py-1">
            {JSON.stringify(invocationArgs, null, 2)}
          </pre>
        </details>
      )}

      {Object.keys(additionalParams).length > 0 && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
            Additional parameters
          </summary>
          <pre className="mt-1 text-xs overflow-x-auto rounded bg-muted px-1.5 py-1">
            {JSON.stringify(additionalParams, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
});

const WebSearchToolRenderer = memo(function WebSearchToolRenderer({
  input,
  resultContent,
}: {
  input: Record<string, unknown>;
  resultContent?: ToolResultContentValue;
}) {
  const resultPayload = resultContent ? parseWebSearchToolResult(resultContent) : null;
  const payload = resultPayload ?? parseWebSearchToolInput(input);

  if (!payload) {
    return (
      <div className="w-0 min-w-full">
        <pre className="text-xs overflow-x-auto max-h-32 overflow-y-auto rounded bg-muted px-1.5 py-1">
          {JSON.stringify(input, null, 2)}
        </pre>
      </div>
    );
  }

  const queries = payload.action.queries ?? (payload.query ? [payload.query] : []);

  return (
    <div className="space-y-1 w-0 min-w-full">
      <div className="rounded bg-muted px-1.5 py-1 font-mono">
        <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words">
          {payload.query || '(query not resolved yet)'}
        </pre>
      </div>
      <div className="text-[10px] text-muted-foreground">action: {payload.action.type}</div>
      {queries.length > 0 && (
        <details className="text-xs">
          <summary className="text-muted-foreground cursor-pointer hover:text-foreground">
            Queries
          </summary>
          <pre className="mt-1 text-xs overflow-x-auto rounded bg-muted px-1.5 py-1">
            {JSON.stringify(queries, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
});

// =============================================================================
// Tool Input Renderer
// =============================================================================

export interface ToolInputRendererProps {
  name: string;
  input: Record<string, unknown>;
  resultContent?: ToolResultContentValue;
}

function renderSpecialToolInput({
  name,
  input,
  resultContent,
}: ToolInputRendererProps): ReactElement | null {
  if (name === 'Task') {
    return <TaskToolRenderer input={input} />;
  }

  if (name === 'TodoWrite') {
    return <TodoWriteToolRenderer input={input} />;
  }

  if (isRunLikeToolName(name)) {
    return <RunToolRenderer input={input} />;
  }

  if (isWebSearchToolName(name)) {
    return <WebSearchToolRenderer input={input} resultContent={resultContent} />;
  }

  const fileChangePayload = parseCodexFileChangeToolInput(input);
  if (fileChangePayload && isCodexFileChangeToolName(name)) {
    return (
      <CodexFileChangeRenderer
        payload={fileChangePayload}
        rawPayload={serializeUnknownPayload(input)}
      />
    );
  }

  return null;
}

export const ToolInputRenderer = memo(function ToolInputRenderer({
  name,
  input,
  resultContent,
}: ToolInputRendererProps) {
  const specialRenderer = renderSpecialToolInput({ name, input, resultContent });
  if (specialRenderer) {
    return specialRenderer;
  }

  // Special rendering for common tools
  switch (name) {
    case 'Read':
      return (
        <div className="space-y-1 w-0 min-w-full">
          <FilePathDisplay path={input.file_path as string} />
          {input.offset !== undefined && (
            <div className="text-xs text-muted-foreground">
              Lines {String(input.offset)} - {Number(input.offset) + (Number(input.limit) || 100)}
            </div>
          )}
        </div>
      );

    case 'Write':
      return (
        <div className="space-y-1 w-0 min-w-full">
          <FilePathDisplay path={input.file_path as string} />
          <div className="rounded bg-muted px-1.5 py-1">
            <pre className="text-xs overflow-x-auto max-h-32 overflow-y-auto">
              {truncateContent((input.content as string) ?? '', TOOL_INPUT_CONTENT_TRUNCATE)}
            </pre>
          </div>
        </div>
      );

    case 'Edit':
      return (
        <div className="space-y-1 w-0 min-w-full">
          <FilePathDisplay path={input.file_path as string} />
          <div className="grid grid-cols-2 gap-1.5">
            <div className="rounded bg-destructive/10 px-1.5 py-1 min-w-0">
              <div className="text-[10px] font-medium text-destructive mb-0.5">Remove</div>
              <pre className="text-xs overflow-x-auto max-h-16 overflow-y-auto">
                {truncateContent((input.old_string as string) ?? '', TOOL_INPUT_DIFF_TRUNCATE)}
              </pre>
            </div>
            <div className="rounded bg-success/10 px-1.5 py-1 min-w-0">
              <div className="text-[10px] font-medium text-success mb-0.5">Add</div>
              <pre className="text-xs overflow-x-auto max-h-16 overflow-y-auto">
                {truncateContent((input.new_string as string) ?? '', TOOL_INPUT_DIFF_TRUNCATE)}
              </pre>
            </div>
          </div>
        </div>
      );

    case 'Bash':
      return (
        <div className="space-y-0.5 w-0 min-w-full">
          <div className="rounded bg-muted px-1.5 py-1 font-mono">
            <pre className="text-xs overflow-x-auto whitespace-pre-wrap">
              {String(input.command ?? '')}
            </pre>
          </div>
          {input.description != null && (
            <div className="text-[10px] text-muted-foreground">{String(input.description)}</div>
          )}
        </div>
      );

    case 'Glob':
    case 'Grep':
      return (
        <div className="space-y-0.5 w-0 min-w-full">
          <div className="font-mono text-xs">{String(input.pattern ?? '')}</div>
          {input.path != null && <FilePathDisplay path={String(input.path)} />}
        </div>
      );

    default:
      // Generic JSON display for unknown tools
      return (
        <div className="w-0 min-w-full">
          <pre className="text-xs overflow-x-auto max-h-32 overflow-y-auto rounded bg-muted px-1.5 py-1">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      );
  }
});
