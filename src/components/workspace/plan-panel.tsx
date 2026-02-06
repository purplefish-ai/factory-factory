/**
 * Plan Panel
 *
 * Displays the plan document for a planning mode session.
 * Supports rendered markdown and raw text view modes.
 * Polls for plan content updates.
 */

import { Code, Eye, FileText } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { usePlanViewMode } from '@/components/chat/plan-view-preference';
import { MarkdownRenderer } from '@/components/ui/markdown';
import { trpc } from '@/frontend/lib/trpc';
import { cn } from '@/lib/utils';

interface PlanPanelProps {
  sessionId: string;
  className?: string;
}

export function PlanPanel({ sessionId, className }: PlanPanelProps) {
  const [viewMode, setViewMode] = usePlanViewMode();
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: planContent } = trpc.plan.getPlanContent.useQuery(
    { sessionId },
    {
      refetchInterval: 3000,
      staleTime: 1000,
      refetchOnWindowFocus: false,
    }
  );

  // Auto-scroll to bottom when content updates (like following a live document)
  const prevContentLengthRef = useRef(0);
  useEffect(() => {
    if (planContent?.content && scrollRef.current) {
      const newLength = planContent.content.length;
      if (newLength > prevContentLengthRef.current) {
        // Content grew — scroll to bottom
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      prevContentLengthRef.current = newLength;
    }
  }, [planContent?.content]);

  const title = planContent?.title ?? 'Plan';
  const hasContent = planContent?.content && planContent.content.trim().length > 0;

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/50">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">{title}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setViewMode('rendered')}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              viewMode === 'rendered'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
            title="Rendered view"
          >
            <Eye className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode('raw')}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              viewMode === 'raw'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
            title="Raw markdown"
          >
            <Code className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {!hasContent ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-4">
            <FileText className="h-8 w-8" />
            <p className="text-sm">Plan document will appear here</p>
            <p className="text-xs text-center">
              The agent will create and update the plan as you discuss.
            </p>
          </div>
        ) : viewMode === 'rendered' ? (
          <div className="p-4">
            <MarkdownRenderer content={planContent.content} />
          </div>
        ) : (
          <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-words text-foreground">
            {planContent.content}
          </pre>
        )}
      </div>

      {/* Footer with file path */}
      {planContent?.filePath && (
        <div className="px-3 py-1.5 border-t bg-muted/30 text-xs text-muted-foreground truncate">
          {planContent.filePath}
        </div>
      )}
    </div>
  );
}
