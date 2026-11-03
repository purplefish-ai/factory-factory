import { memo } from 'react';
import { ChatImage, imageDataUrl } from '@/client/components/chat-image';
import { MarkdownRenderer } from '@/client/components/markdown';
import { withOccurrenceKeys } from '@/client/lib/list-keys';
import type { ImageItem, TextItem, ToolResultContentValue } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import {
  type CodexFileChangePayload,
  isCodexFileChangeToolName,
  parseCodexFileChangeToolResult,
} from './file-change-parser';
import { CodexFileChangeRenderer } from './file-change-renderer';
import { extractPlanToolResult } from './tool-result-plan';

// =============================================================================
// Constants
// =============================================================================

const TOOL_RESULT_CONTENT_TRUNCATE = 20_000;
const TOOL_RESULT_ITEM_TEXT_TRUNCATE = 20_000;

function hasStandaloneFileChangeSignature(payload: CodexFileChangePayload): boolean {
  const hasCallId = payload.id?.startsWith('call_') ?? false;
  const hasStatus = typeof payload.status === 'string' && payload.status.length > 0;
  return payload.changes.length > 0 && (hasCallId || hasStatus);
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n... (truncated)`;
}

// =============================================================================
// Tool Result Content Renderer
// =============================================================================

export interface ToolResultContentRendererProps {
  content: ToolResultContentValue;
  isError: boolean;
  toolName?: string;
}

type ResultGroup = { type: 'image'; item: ImageItem } | { type: 'text'; items: TextItem[] };

function groupResultContent(content: Array<ImageItem | TextItem>): ResultGroup[] {
  const groups: ResultGroup[] = [];
  for (const item of content) {
    if (item.type === 'image') {
      groups.push({ type: 'image', item });
      continue;
    }
    const previous = groups.at(-1);
    if (previous?.type === 'text') {
      previous.items.push(item);
    } else {
      groups.push({ type: 'text', items: [item] });
    }
  }
  return groups;
}

export const ToolResultContentRenderer = memo(function ToolResultContentRenderer({
  content,
  isError,
  toolName,
}: ToolResultContentRendererProps) {
  if (Array.isArray(content)) {
    if (content.some((item) => item.type === 'image')) {
      return (
        <div className="space-y-1 w-0 min-w-full">
          {withOccurrenceKeys(groupResultContent(content), (group) =>
            group.type === 'text'
              ? (group.items[0]?.text.slice(0, 64) ?? '')
              : `${group.item.source.media_type}:${group.item.source.data.length}:${group.item.source.data.slice(0, 64)}:${group.item.source.data.slice(-64)}`
          ).map(({ item: group, key }) =>
            group.type === 'text' ? (
              <ToolResultContentRenderer
                key={key}
                content={group.items}
                isError={isError}
                toolName={toolName}
              />
            ) : (
              <ChatImage
                key={key}
                src={
                  imageDataUrl(group.item.source.media_type, group.item.source.data) ?? undefined
                }
                alt="tool result image"
                source={`data:${group.item.source.media_type};base64,${group.item.source.data}`}
              />
            )
          )}
        </div>
      );
    }
  }
  const fileChangeResult = isError ? null : parseCodexFileChangeToolResult(content);
  const shouldRenderFileChange =
    fileChangeResult !== null &&
    ((toolName !== undefined && isCodexFileChangeToolName(toolName)) ||
      (toolName === undefined && hasStandaloneFileChangeSignature(fileChangeResult)));

  if (shouldRenderFileChange) {
    return <CodexFileChangeRenderer payload={fileChangeResult} />;
  }

  const planResult = isError ? null : extractPlanToolResult(content);
  if (planResult) {
    const rendered = truncateContent(planResult.planText, TOOL_RESULT_CONTENT_TRUNCATE);
    const raw = truncateContent(planResult.rawText, TOOL_RESULT_CONTENT_TRUNCATE);
    return (
      <div className="space-y-1 w-0 min-w-full">
        <div className="rounded border bg-muted/20">
          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Plan
          </div>
          <div className="border-t px-2 py-2 max-h-64 overflow-y-auto text-sm leading-relaxed">
            <MarkdownRenderer content={rendered} />
          </div>
        </div>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Raw payload
          </summary>
          <pre className="mt-1 overflow-x-auto max-h-40 overflow-y-auto rounded bg-muted px-1.5 py-1">
            {raw}
          </pre>
        </details>
      </div>
    );
  }

  if (typeof content === 'string') {
    return (
      <div className="w-0 min-w-full">
        <pre
          className={cn(
            'text-xs overflow-x-auto max-h-40 overflow-y-auto rounded px-1.5 py-1',
            isError ? 'bg-destructive/10 text-destructive' : 'bg-muted'
          )}
        >
          {truncateContent(content, TOOL_RESULT_CONTENT_TRUNCATE)}
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
              {truncateContent(item.text ?? '', TOOL_RESULT_ITEM_TEXT_TRUNCATE)}
            </pre>
          );
        }
        return null;
      })}
    </div>
  );
});
