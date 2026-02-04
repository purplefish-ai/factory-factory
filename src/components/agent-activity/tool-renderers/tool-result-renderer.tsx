import { memo } from 'react';
import type { ToolResultContentValue } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

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
