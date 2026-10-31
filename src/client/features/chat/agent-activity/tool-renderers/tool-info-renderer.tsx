import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { memo, useState } from 'react';
import { AgentProposalCard, extractAgentProposal } from '@/client/features/agent-authoring';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { AgentMessage, PairedToolCall, ToolSequence } from '@/lib/chat-protocol';
import {
  extractToolInfo,
  extractToolResultInfo,
  isToolResultMessage,
  isToolUseMessage,
} from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import {
  getToolActivityKind,
  getToolActivityLabel,
  getToolGroupLabel,
} from './tool-activity-summary';
import { ToolInputRenderer } from './tool-input-renderer';
import { ToolResultContentRenderer } from './tool-result-renderer';
import { isWebSearchToolName, parseWebSearchToolResult } from './web-search-parser';

const triggerClassName =
  'group flex w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function ActivityIcon({
  name,
  pending,
  error,
}: {
  name: string;
  pending?: boolean;
  error?: boolean;
}) {
  const kind = getToolActivityKind(name);
  const Icon = error
    ? WarningCircleIcon
    : pending
      ? SpinnerGapIcon
      : kind === 'edit'
        ? PencilSimpleIcon
        : kind === 'search' || kind === 'read'
          ? MagnifyingGlassIcon
          : TerminalIcon;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'h-4 w-4 shrink-0',
        pending && !error && 'animate-spin',
        error && 'text-destructive'
      )}
    />
  );
}

function DisclosureCaret() {
  return (
    <CaretRightIcon
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 opacity-50 transition-transform group-data-[state=open]:rotate-90"
    />
  );
}

export interface ToolInfoRendererProps {
  message: AgentMessage;
  defaultOpen?: boolean;
  isPending?: boolean;
}

export const ToolInfoRenderer = memo(function ToolInfoRenderer({
  message,
  defaultOpen = false,
  isPending = false,
}: ToolInfoRendererProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  if (isToolUseMessage(message)) {
    const tool = extractToolInfo(message);
    if (!tool) {
      return null;
    }
    return (
      <PairedToolCallRenderer
        call={{ ...tool, status: isPending ? 'pending' : 'success' }}
        open={isOpen}
        onOpenChange={setIsOpen}
      />
    );
  }
  if (!isToolResultMessage(message)) {
    return null;
  }
  const result = extractToolResultInfo(message);
  if (!result) {
    return null;
  }
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(triggerClassName, result.isError && 'text-destructive')}
        >
          <ActivityIcon name="Result" error={result.isError} />
          <span>{result.isError ? 'Tool failed' : 'Tool output'}</span>
          <DisclosureCaret />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-6 mt-1 min-w-0 border-l border-border/60 pl-3">
        <ToolResultContentRenderer content={result.content} isError={result.isError} />
      </CollapsibleContent>
    </Collapsible>
  );
});

export interface ToolSequenceGroupProps {
  sequence: ToolSequence;
  defaultOpen?: boolean;
  summaryOrder?: 'oldest-first' | 'latest-first';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  getCallOpen?: (callId: string, defaultOpen: boolean) => boolean;
  onCallOpenChange?: (callId: string, open: boolean) => void;
  toolDetailsClassName?: string;
  toolDetailsMaxHeight?: number;
}

/** Quiet activity summary; details stay chronological and expand only on request. */
export const ToolSequenceGroup = memo(function ToolSequenceGroup({
  sequence,
  defaultOpen = false,
  open,
  onOpenChange,
  getCallOpen,
  onCallOpenChange,
  toolDetailsClassName,
  toolDetailsMaxHeight,
}: ToolSequenceGroupProps) {
  const controlled = open !== undefined && onOpenChange !== undefined;
  const [internalOpen, setInternalOpen] = useState(open ?? defaultOpen);
  const isOpen = controlled ? open : internalOpen;
  const setIsOpen = controlled ? onOpenChange : setInternalOpen;
  const calls = sequence.pairedCalls;
  const first = calls[0];
  if (!first) {
    return null;
  }
  const pending = calls.some((call) => call.status === 'pending');
  const label = getToolGroupLabel(calls);
  const proposals = new Map(
    calls.flatMap((call) => {
      const proposal =
        call.result && !call.result.isError
          ? extractAgentProposal(call.result.content, call.name)
          : null;
      return proposal
        ? [[`${proposal.workspaceId}:${proposal.proposalId}`, proposal] as const]
        : [];
    })
  );
  return (
    <div className="min-w-0">
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="min-w-0">
        <CollapsibleTrigger asChild>
          <button type="button" className={triggerClassName}>
            {pending ? (
              <SpinnerGapIcon aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
            ) : (
              <FolderSimpleIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0 truncate" title={label}>
              {label}
            </span>
            {pending && <span className="sr-only">Running</span>}
            <DisclosureCaret />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="ml-1 mt-1 space-y-0.5">
          {calls.map((call) => {
            const callOpen = getCallOpen?.(call.id, false);
            return (
              <PairedToolCallRenderer
                key={call.id}
                call={call}
                open={callOpen}
                onOpenChange={
                  callOpen !== undefined && onCallOpenChange
                    ? (next) => onCallOpenChange(call.id, next)
                    : undefined
                }
                detailsClassName={toolDetailsClassName}
                detailsMaxHeight={toolDetailsMaxHeight}
              />
            );
          })}
        </CollapsibleContent>
      </Collapsible>
      {[...proposals].map(([key, reference]) => (
        <AgentProposalCard key={key} reference={reference} />
      ))}
    </div>
  );
});

interface PairedToolCallRendererProps {
  call: PairedToolCall;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  detailsClassName?: string;
  detailsMaxHeight?: number;
}

const PairedToolCallRenderer = memo(function PairedToolCallRenderer({
  call,
  open,
  onOpenChange,
  detailsClassName,
  detailsMaxHeight,
}: PairedToolCallRendererProps) {
  const controlled = open !== undefined && onOpenChange !== undefined;
  const [internalOpen, setInternalOpen] = useState(open ?? false);
  const isOpen = controlled ? open : internalOpen;
  const setIsOpen = controlled ? onOpenChange : setInternalOpen;
  const payload =
    isWebSearchToolName(call.name) && call.result?.content
      ? parseWebSearchToolResult(call.result.content)
      : null;
  const label = getToolActivityLabel(payload ? { ...call, input: { ...payload } } : call);
  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="min-w-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(triggerClassName, call.status === 'error' && 'text-destructive')}
        >
          <ActivityIcon
            name={call.name}
            pending={call.status === 'pending'}
            error={call.status === 'error'}
          />
          <span className="min-w-0 truncate" title={label}>
            {label}
          </span>
          {call.status === 'pending' && <span className="sr-only">Running</span>}
          {call.status === 'error' && <span className="sr-only">Error</span>}
          <DisclosureCaret />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          className={cn(
            'ml-6 mt-1 space-y-2 overflow-x-auto border-l border-border/60 py-1 pl-3',
            detailsClassName
          )}
          style={detailsMaxHeight ? { maxHeight: `${detailsMaxHeight}px` } : undefined}
        >
          <div className="min-w-0">
            <div className="mb-0.5 text-[10px] font-medium text-muted-foreground">Input</div>
            <ToolInputRenderer
              name={call.name}
              input={call.input}
              resultContent={call.result?.content}
            />
          </div>
          {call.result && (
            <div className="min-w-0">
              <div className="mb-0.5 text-[10px] font-medium text-muted-foreground">Result</div>
              <ToolResultContentRenderer
                content={call.result.content}
                isError={call.result.isError}
                toolName={call.name}
              />
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});
