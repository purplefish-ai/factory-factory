import { TreeStructure } from '@phosphor-icons/react';
import { memo } from 'react';
import type { AgentMessage } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';

interface ChildWorkspaceUpdateRendererProps {
  message: AgentMessage;
  className?: string;
}

export const ChildWorkspaceUpdateRenderer = memo(function ChildWorkspaceUpdateRenderer({
  message,
  className,
}: ChildWorkspaceUpdateRendererProps) {
  const { childWorkspaceName, childProjectName, text } = message;

  return (
    <div
      className={cn(
        'rounded-md border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 p-3 space-y-1.5',
        className
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-violet-700 dark:text-violet-400">
        <TreeStructure className="h-3 w-3 shrink-0" />
        <span>
          {childWorkspaceName ?? 'Child workspace'}
          {childProjectName && (
            <span className="font-normal text-violet-500 dark:text-violet-500">
              {' '}
              &middot; {childProjectName}
            </span>
          )}
        </span>
      </div>
      {text && <p className="text-sm text-foreground whitespace-pre-wrap break-words">{text}</p>}
    </div>
  );
});
