'use client';

import { AlertCircle, CheckCircle, ChevronDown, ChevronRight, Clock, Coins } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { ChatMessage, ClaudeMessage, ToolResultContentValue } from '@/lib/claude-types';
import {
  extractTextFromMessage,
  extractToolInfo,
  extractToolResultInfo,
  isTextContent,
  isThinkingContent,
  isToolResultMessage,
  isToolUseMessage,
} from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface MessageRendererProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

// =============================================================================
// Helper Components
// =============================================================================

/**
 * Renders a streaming cursor indicator.
 */
function StreamingCursor() {
  return <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-0.5" />;
}

/**
 * Formats tool input for display.
 */
function formatToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * Formats tool result content for display.
 */
function formatToolResultContent(content: ToolResultContentValue): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item.type === 'text') {
          return item.text;
        }
        if (item.type === 'image') {
          return '[Image]';
        }
        return '';
      })
      .join('\n');
  }
  return String(content);
}

/**
 * Renders a collapsible tool use block.
 */
function ToolUseBlock({ name, input }: { name: string; input: Record<string, unknown> }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full text-left p-2 hover:bg-muted/50 rounded-md transition-colors">
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-indigo-500" />
        ) : (
          <ChevronRight className="h-4 w-4 text-indigo-500" />
        )}
        <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200">
          {name}
        </Badge>
        <span className="text-xs text-muted-foreground">Tool Call</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <pre className="text-xs bg-muted/50 p-3 rounded-md overflow-x-auto max-h-64 overflow-y-auto">
          {formatToolInput(input)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Renders a collapsible tool result block.
 */
function ToolResultBlock({
  content,
  isError,
}: {
  content: ToolResultContentValue;
  isError: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const formattedContent = formatToolResultContent(content);
  const isLong = formattedContent.length > 200;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex items-center gap-2 w-full text-left p-2 hover:bg-muted/50 rounded-md transition-colors">
        {isOpen ? (
          <ChevronDown className={cn('h-4 w-4', isError ? 'text-red-500' : 'text-green-500')} />
        ) : (
          <ChevronRight className={cn('h-4 w-4', isError ? 'text-red-500' : 'text-green-500')} />
        )}
        {isError ? (
          <AlertCircle className="h-4 w-4 text-red-500" />
        ) : (
          <CheckCircle className="h-4 w-4 text-green-500" />
        )}
        <span className={cn('text-xs', isError ? 'text-red-600' : 'text-green-600')}>
          {isError ? 'Error' : 'Result'}
        </span>
        {!(isOpen || isLong) && (
          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
            {formattedContent.slice(0, 50)}
            {formattedContent.length > 50 ? '...' : ''}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <pre
          className={cn(
            'text-xs p-3 rounded-md overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap',
            isError ? 'bg-red-50 text-red-800' : 'bg-green-50 text-green-800'
          )}
        >
          {formattedContent}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Renders result statistics (tokens, duration, cost).
 */
function ResultStats({
  inputTokens,
  outputTokens,
  durationMs,
  costUsd,
  numTurns,
}: {
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  costUsd?: number;
  numTurns?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground p-2 bg-muted/30 rounded-md">
      {(inputTokens !== undefined || outputTokens !== undefined) && (
        <div className="flex items-center gap-1">
          <span className="font-medium">Tokens:</span>
          <span>
            {inputTokens ?? 0} in / {outputTokens ?? 0} out
          </span>
        </div>
      )}
      {durationMs !== undefined && (
        <div className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          <span>{(durationMs / 1000).toFixed(2)}s</span>
        </div>
      )}
      {costUsd !== undefined && (
        <div className="flex items-center gap-1">
          <Coins className="h-3 w-3" />
          <span>${costUsd.toFixed(4)}</span>
        </div>
      )}
      {numTurns !== undefined && (
        <div className="flex items-center gap-1">
          <span className="font-medium">Turns:</span>
          <span>{numTurns}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Renders system message content.
 */
function SystemMessage({ message }: { message: ClaudeMessage }) {
  const subtype = message.subtype ?? 'info';
  const model = message.model;
  const cwd = message.cwd;
  const status = message.status;

  return (
    <div className="text-xs text-muted-foreground p-2 bg-muted/30 rounded-md space-y-1">
      {subtype === 'init' && (
        <>
          {model && <div>Model: {model}</div>}
          {cwd && <div>Working directory: {cwd}</div>}
          {message.tools && <div>Tools available: {message.tools.length}</div>}
        </>
      )}
      {subtype === 'status' && status && <div>Status: {status}</div>}
      {subtype !== 'init' && subtype !== 'status' && <div>System: {subtype}</div>}
    </div>
  );
}

/**
 * Renders error message content.
 */
function ErrorMessage({ error }: { error: string }) {
  return (
    <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md">
      <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
      <span className="text-sm text-red-800">{error}</span>
    </div>
  );
}

/**
 * Renders text content with optional streaming cursor.
 */
function TextBlock({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  if (!(text || isStreaming)) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap text-sm">
      {text}
      {isStreaming && <StreamingCursor />}
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

/**
 * Renders a single message based on its type.
 * This function handles many message types by design, hence the complexity.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Message type dispatcher requires multiple type checks
export function MessageRenderer({ message, isStreaming = false }: MessageRendererProps) {
  // User message
  if (message.source === 'user') {
    return (
      <Card className="bg-primary text-primary-foreground ml-auto max-w-[80%]">
        <CardContent className="p-3">
          <p className="text-sm whitespace-pre-wrap">{message.text}</p>
        </CardContent>
      </Card>
    );
  }

  // Claude message
  const claudeMsg = message.message;
  if (!claudeMsg) {
    return null;
  }

  // Error message
  if (claudeMsg.type === 'error') {
    return (
      <div className="max-w-[80%]">
        <ErrorMessage error={claudeMsg.error ?? 'Unknown error'} />
      </div>
    );
  }

  // System message
  if (claudeMsg.type === 'system') {
    return (
      <div className="max-w-[80%]">
        <SystemMessage message={claudeMsg} />
      </div>
    );
  }

  // Result message with stats
  if (claudeMsg.type === 'result') {
    return (
      <div className="max-w-[80%]">
        <ResultStats
          inputTokens={claudeMsg.usage?.input_tokens}
          outputTokens={claudeMsg.usage?.output_tokens}
          durationMs={claudeMsg.duration_ms}
          costUsd={claudeMsg.total_cost_usd}
          numTurns={claudeMsg.num_turns}
        />
      </div>
    );
  }

  // Tool use message
  if (isToolUseMessage(claudeMsg)) {
    const toolInfo = extractToolInfo(claudeMsg);
    if (toolInfo) {
      return (
        <Card className="bg-muted/30 max-w-[80%]">
          <CardContent className="p-2">
            <ToolUseBlock name={toolInfo.name} input={toolInfo.input} />
          </CardContent>
        </Card>
      );
    }
  }

  // Tool result message
  if (isToolResultMessage(claudeMsg)) {
    const resultInfo = extractToolResultInfo(claudeMsg);
    if (resultInfo) {
      return (
        <Card className="bg-muted/30 max-w-[80%]">
          <CardContent className="p-2">
            <ToolResultBlock content={resultInfo.content} isError={resultInfo.isError} />
          </CardContent>
        </Card>
      );
    }
  }

  // Stream event with text delta
  if (claudeMsg.type === 'stream_event' && claudeMsg.event) {
    const event = claudeMsg.event;

    // Content block delta (streaming text)
    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta.type === 'text_delta') {
        return (
          <div className="max-w-[80%]">
            <TextBlock text={delta.text} isStreaming={isStreaming} />
          </div>
        );
      }
      if (delta.type === 'thinking_delta') {
        return (
          <div className="max-w-[80%] text-muted-foreground italic">
            <TextBlock text={delta.thinking} isStreaming={isStreaming} />
          </div>
        );
      }
    }

    // Content block start with text
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (isTextContent(block) && block.text) {
        return (
          <div className="max-w-[80%]">
            <TextBlock text={block.text} isStreaming={isStreaming} />
          </div>
        );
      }
      if (isThinkingContent(block) && block.thinking) {
        return (
          <div className="max-w-[80%] text-muted-foreground italic">
            <TextBlock text={block.thinking} isStreaming={isStreaming} />
          </div>
        );
      }
    }
  }

  // Assistant/user message with content
  if ((claudeMsg.type === 'assistant' || claudeMsg.type === 'user') && claudeMsg.message) {
    const text = extractTextFromMessage(claudeMsg);
    if (text) {
      return (
        <Card className="bg-muted/30 max-w-[80%]">
          <CardContent className="p-3">
            <TextBlock text={text} isStreaming={isStreaming} />
          </CardContent>
        </Card>
      );
    }
  }

  // Fallback: try to extract any text
  const text = extractTextFromMessage(claudeMsg);
  if (text) {
    return (
      <Card className="bg-muted/30 max-w-[80%]">
        <CardContent className="p-3">
          <TextBlock text={text} isStreaming={isStreaming} />
        </CardContent>
      </Card>
    );
  }

  // Nothing to render
  return null;
}
