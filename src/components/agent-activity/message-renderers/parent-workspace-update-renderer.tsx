import { DownloadSimpleIcon } from '@phosphor-icons/react';
import { memo } from 'react';
import type { AgentMessage } from '@/lib/chat-protocol';
import { cn } from '@/lib/utils';

interface ParentWorkspaceUpdateRendererProps {
  message: AgentMessage;
  className?: string;
}

export const ParentWorkspaceUpdateRenderer = memo(function ParentWorkspaceUpdateRenderer({
  message,
  className,
}: ParentWorkspaceUpdateRendererProps) {
  const { parentWorkspaceName, parentProjectName, text } = message;

  return (
    <div
      className={cn(
        'rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-1.5',
        className
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
        <DownloadSimpleIcon className="h-3 w-3 shrink-0" />
        <span>
          {parentWorkspaceName ?? 'Parent workspace'}
          {parentProjectName && (
            <span className="font-normal text-amber-500 dark:text-amber-500">
              {' '}
              &middot; {parentProjectName}
            </span>
          )}
        </span>
      </div>
      {text && <p className="text-sm text-foreground whitespace-pre-wrap break-words">{text}</p>}
    </div>
  );
});
