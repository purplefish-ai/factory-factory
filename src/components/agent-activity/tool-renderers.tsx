'use client';

import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  FileCode,
  Terminal,
} from 'lucide-react';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { ClaudeMessage, ToolResultContentValue } from '@/lib/claude-types';
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

interface ToolInfoRendererProps {
  message: ClaudeMessage;
  defaultOpen?: boolean;
}

/**
 * Renders tool use or tool result information.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex but readable conditional rendering
export function ToolInfoRenderer({ message, defaultOpen = false }: ToolInfoRendererProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);

  // Check if this is a tool use message
  if (isToolUseMessage(message)) {
    const toolInfo = extractToolInfo(message);
    if (!toolInfo) {
      return null;
    }

    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <div className="rounded-md border bg-muted/30">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center gap-2 p-2 text-left hover:bg-muted/50 transition-colors">
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <Terminal className="h-4 w-4 text-muted-foreground" />
              <span className="font-mono text-sm">{toolInfo.name}</span>
              <Badge variant="outline" className="ml-auto text-xs">
                Tool Call
              </Badge>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t p-2">
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
            'rounded-md border',
            resultInfo.isError ? 'border-destructive/50 bg-destructive/5' : 'bg-muted/30'
          )}
        >
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center gap-2 p-2 text-left hover:bg-muted/50 transition-colors">
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              {resultInfo.isError ? (
                <AlertCircle className="h-4 w-4 text-destructive" />
              ) : (
                <CheckCircle className="h-4 w-4 text-success" />
              )}
              <span className="text-sm text-muted-foreground">Tool Result</span>
              <Badge
                variant={resultInfo.isError ? 'destructive' : 'success'}
                className="ml-auto text-xs"
              >
                {resultInfo.isError ? 'Error' : 'Success'}
              </Badge>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t p-2">
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
}

// =============================================================================
// Tool Input Renderer
// =============================================================================

interface ToolInputRendererProps {
  name: string;
  input: Record<string, unknown>;
}

function ToolInputRenderer({ name, input }: ToolInputRendererProps) {
  // Special rendering for common tools
  switch (name) {
    case 'Read':
      return (
        <div className="space-y-1">
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
        <div className="space-y-2">
          <FilePathDisplay path={input.file_path as string} />
          <div className="rounded bg-muted p-2">
            <pre className="text-xs overflow-x-auto max-h-40 overflow-y-auto">
              {truncateContent(input.content as string, 500)}
            </pre>
          </div>
        </div>
      );

    case 'Edit':
      return (
        <div className="space-y-2">
          <FilePathDisplay path={input.file_path as string} />
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded bg-destructive/10 p-2">
              <div className="text-xs font-medium text-destructive mb-1">Remove</div>
              <pre className="text-xs overflow-x-auto max-h-20 overflow-y-auto">
                {truncateContent(input.old_string as string, 200)}
              </pre>
            </div>
            <div className="rounded bg-success/10 p-2">
              <div className="text-xs font-medium text-success mb-1">Add</div>
              <pre className="text-xs overflow-x-auto max-h-20 overflow-y-auto">
                {truncateContent(input.new_string as string, 200)}
              </pre>
            </div>
          </div>
        </div>
      );

    case 'Bash':
      return (
        <div className="space-y-1">
          <div className="rounded bg-muted p-2 font-mono">
            <pre className="text-xs overflow-x-auto whitespace-pre-wrap">
              {String(input.command ?? '')}
            </pre>
          </div>
          {input.description != null && (
            <div className="text-xs text-muted-foreground">{String(input.description)}</div>
          )}
        </div>
      );

    case 'Glob':
    case 'Grep':
      return (
        <div className="space-y-1">
          <div className="font-mono text-sm">{String(input.pattern ?? '')}</div>
          {input.path != null && <FilePathDisplay path={String(input.path)} />}
        </div>
      );

    default:
      // Generic JSON display for unknown tools
      return (
        <pre className="text-xs overflow-x-auto max-h-40 overflow-y-auto rounded bg-muted p-2">
          {JSON.stringify(input, null, 2)}
        </pre>
      );
  }
}

// =============================================================================
// Tool Result Content Renderer
// =============================================================================

interface ToolResultContentRendererProps {
  content: ToolResultContentValue;
  isError: boolean;
}

function ToolResultContentRenderer({ content, isError }: ToolResultContentRendererProps) {
  if (typeof content === 'string') {
    return (
      <pre
        className={cn(
          'text-xs overflow-x-auto max-h-60 overflow-y-auto rounded p-2',
          isError ? 'bg-destructive/10 text-destructive' : 'bg-muted'
        )}
      >
        {truncateContent(content, 2000)}
      </pre>
    );
  }

  // Handle array of text/image items
  return (
    <div className="space-y-2">
      {content.map((item, index) => {
        const key =
          item.type === 'text' ? `text-${index}-${(item.text ?? '').slice(0, 20)}` : `img-${index}`;
        if (item.type === 'text') {
          return (
            <pre
              key={key}
              className={cn(
                'text-xs overflow-x-auto max-h-60 overflow-y-auto rounded p-2',
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
}

// =============================================================================
// Tool Call Group Renderer
// =============================================================================

interface ToolCallGroupRendererProps {
  toolCalls: ToolCallInfo[];
  defaultOpen?: boolean;
}

/**
 * Renders a group of related tool calls.
 */
export function ToolCallGroupRenderer({
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
      <div className="rounded-md border bg-muted/20">
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center gap-2 p-2 text-left hover:bg-muted/50 transition-colors">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">{toolCalls.length} tool calls</span>
            <div className="ml-auto flex gap-1">
              {successCount > 0 && (
                <Badge variant="success" className="text-xs">
                  {successCount}
                </Badge>
              )}
              {errorCount > 0 && (
                <Badge variant="destructive" className="text-xs">
                  {errorCount}
                </Badge>
              )}
              {pendingCount > 0 && (
                <Badge variant="outline" className="text-xs">
                  {pendingCount}
                </Badge>
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t divide-y">
            {toolCalls.map((toolCall) => (
              <ToolCallItem key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// =============================================================================
// Tool Call Item
// =============================================================================

interface ToolCallItemProps {
  toolCall: ToolCallInfo;
}

function ToolCallItem({ toolCall }: ToolCallItemProps) {
  const [isOpen, setIsOpen] = React.useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-2 p-2 text-left hover:bg-muted/30 transition-colors">
          {isOpen ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="font-mono text-xs">{toolCall.name}</span>
          {toolCall.result && (
            <span className="ml-auto">
              {toolCall.result.isError ? (
                <AlertCircle className="h-3 w-3 text-destructive" />
              ) : (
                <CheckCircle className="h-3 w-3 text-success" />
              )}
            </span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="px-6 pb-2 space-y-2">
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
}

// =============================================================================
// Helper Components
// =============================================================================

function FilePathDisplay({ path }: { path: string }) {
  if (!path) {
    return null;
  }

  // Extract filename from path
  const parts = path.split('/');
  const filename = parts[parts.length - 1];
  const directory = parts.slice(0, -1).join('/');

  return (
    <div className="flex items-center gap-1 text-sm">
      <FileCode className="h-3 w-3 text-muted-foreground" />
      <span className="text-muted-foreground">{directory}/</span>
      <span className="font-medium">{filename}</span>
    </div>
  );
}

// =============================================================================
// Utility Functions
// =============================================================================

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n... (truncated)`;
}
