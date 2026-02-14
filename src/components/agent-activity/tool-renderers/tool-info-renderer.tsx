import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Terminal,
} from 'lucide-react';
import * as React from 'react';
import { memo } from 'react';
import type { ToolCallInfo } from '@/components/agent-activity/types';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { AgentMessage, PairedToolCall, ToolSequence } from '@/lib/chat-protocol';
import {
  extractToolInfo,
  extractToolResultInfo,
  isToolResultMessage,
  isToolUseMessage,
} from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { getDisplayToolName } from './tool-display-utils';
import { ToolInputRenderer } from './tool-input-renderer';
import { ToolResultContentRenderer } from './tool-result-renderer';

// =============================================================================
// Tool Info Renderer
// =============================================================================

export interface ToolInfoRendererProps {
  message: AgentMessage;
  defaultOpen?: boolean;
  isPending?: boolean;
}

/**
 * Renders tool use or tool result information.
 */
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
    const displayName = getDisplayToolName(toolInfo.name, toolInfo.input);

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
              <span className="font-mono text-xs flex-1 min-w-0 truncate" title={toolInfo.name}>
                {displayName}
              </span>
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
  summaryOrder?: 'oldest-first' | 'latest-first';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  toolDetailsClassName?: string;
  toolDetailsMaxHeight?: number;
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
  summaryOrder = 'oldest-first',
  open,
  onOpenChange,
  toolDetailsClassName,
  toolDetailsMaxHeight,
}: ToolSequenceGroupProps) {
  const isControlled = open !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isOpen = open ?? internalOpen;
  const setIsOpen = onOpenChange ?? setInternalOpen;

  const { pairedCalls } = sequence;
  // For the header summary, use the specified order
  const summaryCalls = summaryOrder === 'latest-first' ? [...pairedCalls].reverse() : pairedCalls;
  // For the expanded view, always show oldest-first (chronological order)
  const expandedCalls = pairedCalls;

  if (pairedCalls.length === 0) {
    return null;
  }

  // Single tool call - render inline without grouping wrapper
  if (pairedCalls.length === 1) {
    const firstCall = summaryCalls[0];
    if (!firstCall) {
      return null;
    }
    return (
      <PairedToolCallRenderer
        call={firstCall}
        defaultOpen={isControlled ? undefined : defaultOpen}
        open={isOpen}
        onOpenChange={setIsOpen}
        detailsClassName={toolDetailsClassName}
        detailsMaxHeight={toolDetailsMaxHeight}
      />
    );
  }

  // Multiple tool calls - render as collapsible group
  // Count statuses for summary display
  const statusCounts = {
    success: pairedCalls.filter((c) => c.status === 'success').length,
    error: pairedCalls.filter((c) => c.status === 'error').length,
    pending: pairedCalls.filter((c) => c.status === 'pending').length,
  };

  const renderStatusIndicators = () => {
    // Show counts instead of individual icons when there are many tool calls
    const MAX_INDIVIDUAL_ICONS = 8;
    if (pairedCalls.length > MAX_INDIVIDUAL_ICONS) {
      return (
        <>
          {statusCounts.success > 0 && (
            <span
              className="flex items-center gap-0.5"
              title={`${statusCounts.success} successful`}
            >
              <CheckCircle className="h-3.5 w-3.5 shrink-0 text-success" />
              <span className="text-[10px] text-success">{statusCounts.success}</span>
            </span>
          )}
          {statusCounts.error > 0 && (
            <span className="flex items-center gap-0.5" title={`${statusCounts.error} failed`}>
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
              <span className="text-[10px] text-destructive">{statusCounts.error}</span>
            </span>
          )}
          {statusCounts.pending > 0 && (
            <span className="flex items-center gap-0.5" title={`${statusCounts.pending} pending`}>
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">{statusCounts.pending}</span>
            </span>
          )}
        </>
      );
    }

    // Show individual icons for small numbers of tool calls
    return summaryCalls.map((call) => {
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
    const displayCalls = summaryCalls.length <= 4 ? summaryCalls : summaryCalls.slice(0, 3);
    const remaining = summaryCalls.length > 4 ? summaryCalls.length - 3 : 0;

    return (
      <>
        {displayCalls.map((call, index) => (
          <React.Fragment key={call.id}>
            <span className={call.status === 'error' ? 'text-destructive' : undefined}>
              {getDisplayToolName(call.name, call.input, { summary: true })}
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
            <span className="text-xs min-w-0 flex-1 truncate">
              {pairedCalls.length} tools: {formatToolNames()}
            </span>
            <span className="ml-auto flex gap-1 text-xs">{renderStatusIndicators()}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t space-y-1 p-1.5 overflow-x-auto">
            {expandedCalls.map((call) => (
              <div key={call.id} className="pl-2">
                <PairedToolCallRenderer
                  call={call}
                  defaultOpen={false}
                  detailsClassName={toolDetailsClassName}
                  detailsMaxHeight={toolDetailsMaxHeight}
                />
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
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  detailsClassName?: string;
  detailsMaxHeight?: number;
}

/**
 * Renders a single tool call paired with its result.
 * Shows: ToolName [status] - expands to show input and result.
 */
const PairedToolCallRenderer = memo(function PairedToolCallRenderer({
  call,
  defaultOpen = false,
  open,
  onOpenChange,
  detailsClassName,
  detailsMaxHeight,
}: PairedToolCallRendererProps) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const isOpen = open ?? internalOpen;
  const setIsOpen = onOpenChange ?? setInternalOpen;

  const isPending = call.status === 'pending';
  const isError = call.status === 'error';
  const displayName = getDisplayToolName(call.name, call.input);

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
            <span className="font-mono text-xs flex-1 min-w-0 truncate" title={call.name}>
              {displayName}
            </span>
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
          <div
            className={cn('border-t px-2 py-1.5 space-y-2 overflow-x-auto', detailsClassName)}
            style={detailsMaxHeight ? { maxHeight: `${detailsMaxHeight}px` } : undefined}
          >
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
  const displayName = getDisplayToolName(toolCall.name, toolCall.input);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-muted/30 transition-colors">
          {isOpen ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="font-mono text-xs flex-1 min-w-0 truncate" title={toolCall.name}>
            {displayName}
          </span>
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
