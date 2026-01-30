'use client';

import {
  AlertCircle,
  CheckCircle,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Circle,
  FileCode,
  Loader2,
  Square,
  Terminal,
  Zap,
} from 'lucide-react';
import * as React from 'react';
import { memo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type {
  ClaudeMessage,
  PairedToolCall,
  ToolResultContentValue,
  ToolSequence,
} from '@/lib/claude-types';
import {
  extractToolInfo,
  extractToolResultInfo,
  isToolResultMessage,
  isToolUseMessage,
} from '@/lib/claude-types';
import { cn } from '@/lib/utils';
import type { FileReference, ToolCallInfo } from './types';

// =============================================================================
// File Reference Extraction
// =============================================================================

/**
 * Known tools that operate on files and their input field names.
 */
const FILE_TOOL_FIELDS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path'],
  Bash: ['command'],
};

/**
 * Extracts file references from tool input.
 */
export function extractFileReferences(
  toolName: string,
  toolId: string,
  input: Record<string, unknown>
): FileReference[] {
  const references: FileReference[] = [];
  const fields = FILE_TOOL_FIELDS[toolName];

  if (!fields) {
    return references;
  }

  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' && value.startsWith('/')) {
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      references.push({
        path: value,
        lineStart: typeof offset === 'number' ? offset : undefined,
        lineEnd:
          typeof offset === 'number' && typeof limit === 'number' ? offset + limit : undefined,
        toolName,
        toolCallId: toolId,
      });
    }
  }

  return references;
}

// =============================================================================
// Tool Info Renderer
// =============================================================================

export interface ToolInfoRendererProps {
  message: ClaudeMessage;
  defaultOpen?: boolean;
  isPending?: boolean;
}

/**
 * Renders tool use or tool result information.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex but readable conditional rendering
export const ToolInfoRenderer = memo(function ToolInfoRenderer({
  message,
  defaultOpen = false,
  isPending = false,
}: ToolInfoRendererProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  // Check if this is a tool use message
  if (isToolUseMessage(message)) {
    const toolInfo = extractToolInfo(message);
    if (!toolInfo) {
      return null;
    }

    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="rounded border bg-muted/30 min-w-0">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/50 transition-colors">
              {isOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              {isPending ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="font-mono text-xs">{toolInfo.name}</span>
              {isPending ? (
                <Badge variant="outline" className="ml-auto text-[10px] px-1 py-0 animate-pulse">
                  Running...
                </Badge>
              ) : (
                <Badge variant="outline" className="ml-auto text-[10px] px-1 py-0">
                  Tool Call
                </Badge>
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t px-2 py-1.5 overflow-x-auto">
              <ToolInputRenderer name={toolInfo.name} input={toolInfo.input} />
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    );
  }

  // Check if this is a tool result message
  if (isToolResultMessage(message)) {
    const resultInfo = extractToolResultInfo(message);
    if (!resultInfo) {
      return null;
    }

    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div
          className={cn(
            'rounded border min-w-0',
            resultInfo.isError ? 'border-destructive/50 bg-destructive/5' : 'bg-muted/30'
          )}
        >
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/50 transition-colors">
              {isOpen ? (
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              {resultInfo.isError ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
              ) : (
                <CheckCircle className="h-4 w-4 shrink-0 text-success" />
              )}
              <span className="text-xs text-muted-foreground">Tool Result</span>
              <Badge
                variant={resultInfo.isError ? 'destructive' : 'success'}
                className="ml-auto text-[10px] px-1 py-0"
              >
                {resultInfo.isError ? 'Error' : 'Success'}
              </Badge>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t px-2 py-1.5 overflow-x-auto">
              <ToolResultContentRenderer
                content={resultInfo.content}
                isError={resultInfo.isError}
              />
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    );
  }

  return null;
});

// =============================================================================
// Tool Sequence Group Renderer
// =============================================================================

export interface ToolSequenceGroupProps {
  sequence: ToolSequence;
  defaultOpen?: boolean;
}

/**
 * Renders a group of adjacent tool calls.
 * Each tool_use is paired with its corresponding tool_result.
 * - Single tool: Shows inline with status, expands to show input + result
 * - Multiple tools: Shows summary "3 tools: Read, Edit, Bash [✓][✓][✓]", expands to show all
 */
export const ToolSequenceGroup = memo(function ToolSequenceGroup({
  sequence,
  defaultOpen = false,
}: ToolSequenceGroupProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  const { pairedCalls } = sequence;

  if (pairedCalls.length === 0) {
    return null;
  }

  // Single tool call - render inline without grouping wrapper
  if (pairedCalls.length === 1) {
    return <PairedToolCallRenderer call={pairedCalls[0]} defaultOpen={defaultOpen} />;
  }

  // Multiple tool calls - render as collapsible group
  const renderStatusIndicators = () => {
    return pairedCalls.map((call) => {
      const key = `${sequence.id}-status-${call.id}`;
      switch (call.status) {
        case 'success':
          return (
            <span key={key} title="Success">
              <CheckCircle className="h-3.5 w-3.5 shrink-0 text-success" />
            </span>
          );
        case 'error':
          return (
            <span key={key} title="Error">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
            </span>
          );
        case 'pending':
          return (
            <span key={key} title="Pending">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            </span>
          );
      }
    });
  };

  // Format tool names for display (truncate if too many)
  // Returns styled elements where error tools show in red
  const formatToolNames = () => {
    const displayCalls = pairedCalls.length <= 4 ? pairedCalls : pairedCalls.slice(0, 3);
    const remaining = pairedCalls.length > 4 ? pairedCalls.length - 3 : 0;

    return (
      <>
        {displayCalls.map((call, index) => (
          <React.Fragment key={call.id}>
            <span className={call.status === 'error' ? 'text-destructive' : undefined}>
              {call.name}
            </span>
            {index < displayCalls.length - 1 && ', '}
          </React.Fragment>
        ))}
        {remaining > 0 && `, +${remaining} more`}
      </>
    );
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded border bg-muted/20 min-w-0">
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-muted/50 transition-colors">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-xs">
              {pairedCalls.length} tools: {formatToolNames()}
            </span>
            <span className="ml-auto flex gap-1 text-xs">{renderStatusIndicators()}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t space-y-1 p-1.5 overflow-x-auto">
            {pairedCalls.map((call) => (
              <div key={call.id} className="pl-2">
                <PairedToolCallRenderer call={call} defaultOpen={false} />
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});

// =============================================================================
// Paired Tool Call Renderer
// =============================================================================

interface PairedToolCallRendererProps {
  call: PairedToolCall;
  defaultOpen?: boolean;
}

/**
 * Renders a single tool call paired with its result.
 * Shows: ToolName [status] - expands to show input and result.
 */
const PairedToolCallRenderer = memo(function PairedToolCallRenderer({
  call,
  defaultOpen = false,
}: PairedToolCallRendererProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  const isPending = call.status === 'pending';
  const isError = call.status === 'error';

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className={cn(
          'rounded border min-w-0',
          isError ? 'border-destructive/50 bg-destructive/5' : 'bg-muted/30'
        )}
      >
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/50 transition-colors">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            {isPending ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : isError ? (
              <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
            ) : (
              <CheckCircle className="h-4 w-4 shrink-0 text-success" />
            )}
            <span className="font-mono text-xs">{call.name}</span>
            {isPending ? (
              <Badge variant="outline" className="ml-auto text-[10px] px-1 py-0 animate-pulse">
                Running...
              </Badge>
            ) : (
              <Badge
                variant={isError ? 'destructive' : 'success'}
                className="ml-auto text-[10px] px-1 py-0"
              >
                {isError ? 'Error' : 'Success'}
              </Badge>
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t px-2 py-1.5 space-y-2 overflow-x-auto">
            {/* Tool Input */}
            <div className="min-w-0">
              <div className="text-[10px] font-medium text-muted-foreground mb-0.5">Input</div>
              <ToolInputRenderer name={call.name} input={call.input} />
            </div>
            {/* Tool Result */}
            {call.result && (
              <div className="min-w-0">
                <div className="text-[10px] font-medium text-muted-foreground mb-0.5">Result</div>
                <ToolResultContentRenderer
                  content={call.result.content}
                  isError={call.result.isError}
                />
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});

// =============================================================================
// Tool Input Renderer
// =============================================================================

interface ToolInputRendererProps {
  name: string;
  input: Record<string, unknown>;
}

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

/**
 * Renders a single todo item
 */
const TodoItemRenderer = memo(function TodoItemRenderer({
  todo,
}: {
  todo: { content: string; activeForm: string; status: 'pending' | 'in_progress' | 'completed' };
}) {
  const StatusIcon =
    todo.status === 'completed' ? CheckSquare : todo.status === 'in_progress' ? Circle : Square;

  const statusColor =
    todo.status === 'completed'
      ? 'text-success'
      : todo.status === 'in_progress'
        ? 'text-primary'
        : 'text-muted-foreground';

  return (
    <div className="flex items-start gap-1.5">
      <StatusIcon className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', statusColor)} />
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'text-xs',
            todo.status === 'completed' && 'line-through text-muted-foreground'
          )}
        >
          {todo.status === 'in_progress' ? todo.activeForm : todo.content}
        </div>
      </div>
    </div>
  );
});

/**
 * Renders TodoWrite tool with visual task list and progress bar
 */
const TodoWriteToolRenderer = memo(function TodoWriteToolRenderer({
  input,
}: {
  input: Record<string, unknown>;
}) {
  const todos = input.todos as
    | Array<{
        content: string;
        activeForm: string;
        status: 'pending' | 'in_progress' | 'completed';
      }>
    | undefined;

  if (!todos || todos.length === 0) {
    return <div className="text-xs text-muted-foreground">No todos</div>;
  }

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const totalCount = todos.length;
  const progressPercent = Math.round((completedCount / totalCount) * 100);

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
          <TodoItemRenderer key={`${todo.content}-${index}`} todo={todo} />
        ))}
      </div>
    </div>
  );
});

const ToolInputRenderer = memo(function ToolInputRenderer({ name, input }: ToolInputRendererProps) {
  // Special rendering for Task tool (subagent launches)
  if (name === 'Task') {
    return <TaskToolRenderer input={input} />;
  }

  // Special rendering for TodoWrite tool
  if (name === 'TodoWrite') {
    return <TodoWriteToolRenderer input={input} />;
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
              {truncateContent(input.content as string, 500)}
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
                {truncateContent(input.old_string as string, 200)}
              </pre>
            </div>
            <div className="rounded bg-success/10 px-1.5 py-1 min-w-0">
              <div className="text-[10px] font-medium text-success mb-0.5">Add</div>
              <pre className="text-xs overflow-x-auto max-h-16 overflow-y-auto">
                {truncateContent(input.new_string as string, 200)}
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

// =============================================================================
// Tool Result Content Renderer
// =============================================================================

interface ToolResultContentRendererProps {
  content: ToolResultContentValue;
  isError: boolean;
}

const ToolResultContentRenderer = memo(function ToolResultContentRenderer({
  content,
  isError,
}: ToolResultContentRendererProps) {
  if (typeof content === 'string') {
    return (
      <div className="w-0 min-w-full">
        <pre
          className={cn(
            'text-xs overflow-x-auto max-h-40 overflow-y-auto rounded px-1.5 py-1',
            isError ? 'bg-destructive/10 text-destructive' : 'bg-muted'
          )}
        >
          {truncateContent(content, 2000)}
        </pre>
      </div>
    );
  }

  // Handle array of text/image items
  return (
    <div className="space-y-1 w-0 min-w-full">
      {content.map((item, index) => {
        const key =
          item.type === 'text' ? `text-${index}-${(item.text ?? '').slice(0, 20)}` : `img-${index}`;
        if (item.type === 'text') {
          return (
            <pre
              key={key}
              className={cn(
                'text-xs overflow-x-auto max-h-40 overflow-y-auto rounded px-1.5 py-1',
                isError ? 'bg-destructive/10 text-destructive' : 'bg-muted'
              )}
            >
              {truncateContent(item.text ?? '', 2000)}
            </pre>
          );
        }
        // Image items could be rendered here if needed
        return (
          <div key={key} className="text-xs text-muted-foreground">
            [Image content]
          </div>
        );
      })}
    </div>
  );
});

// =============================================================================
// Tool Call Group Renderer
// =============================================================================

export interface ToolCallGroupRendererProps {
  toolCalls: ToolCallInfo[];
  defaultOpen?: boolean;
}

/**
 * Renders a group of related tool calls.
 */
export const ToolCallGroupRenderer = memo(function ToolCallGroupRenderer({
  toolCalls,
  defaultOpen = false,
}: ToolCallGroupRendererProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  if (toolCalls.length === 0) {
    return null;
  }

  const successCount = toolCalls.filter((tc) => tc.result && !tc.result.isError).length;
  const errorCount = toolCalls.filter((tc) => tc.result?.isError).length;
  const pendingCount = toolCalls.filter((tc) => !tc.result).length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="rounded border bg-muted/20 min-w-0">
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/50 transition-colors">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
            <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-xs">{toolCalls.length} tool calls</span>
            <div className="ml-auto flex gap-1">
              {successCount > 0 && (
                <Badge variant="success" className="text-[10px] px-1 py-0">
                  {successCount}
                </Badge>
              )}
              {errorCount > 0 && (
                <Badge variant="destructive" className="text-[10px] px-1 py-0">
                  {errorCount}
                </Badge>
              )}
              {pendingCount > 0 && (
                <Badge variant="outline" className="text-[10px] px-1 py-0">
                  {pendingCount}
                </Badge>
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t divide-y overflow-x-auto">
            {toolCalls.map((toolCall) => (
              <ToolCallItem key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
});

// =============================================================================
// Tool Call Item
// =============================================================================

interface ToolCallItemProps {
  toolCall: ToolCallInfo;
}

const ToolCallItem = memo(function ToolCallItem({ toolCall }: ToolCallItemProps) {
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/30 transition-colors">
          {isOpen ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="font-mono text-xs">{toolCall.name}</span>
          {toolCall.result && (
            <span className="ml-auto">
              {toolCall.result.isError ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
              ) : (
                <CheckCircle className="h-4 w-4 shrink-0 text-success" />
              )}
            </span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-4 pb-1.5 space-y-1 overflow-x-auto">
          <ToolInputRenderer name={toolCall.name} input={toolCall.input} />
          {toolCall.result && (
            <ToolResultContentRenderer
              content={toolCall.result.content}
              isError={toolCall.result.isError}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

// =============================================================================
// Helper Components
// =============================================================================

const FilePathDisplay = memo(function FilePathDisplay({ path }: { path: string }) {
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
// Utility Functions
// =============================================================================

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n... (truncated)`;
}
