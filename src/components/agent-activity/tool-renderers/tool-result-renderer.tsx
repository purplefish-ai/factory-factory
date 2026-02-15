import { memo } from 'react';
import { MarkdownRenderer } from '@/components/ui/markdown';
import type { ToolResultContentValue } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';
import { extractPlanToolResult } from './tool-result-plan';

// =============================================================================
// Constants
// =============================================================================

const TOOL_RESULT_CONTENT_TRUNCATE = 20_000;
const TOOL_RESULT_ITEM_TEXT_TRUNCATE = 20_000;

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
}

export const ToolResultContentRenderer = memo(function ToolResultContentRenderer({
  content,
  isError,
}: ToolResultContentRendererProps) {
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
