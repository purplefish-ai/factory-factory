import { GitPullRequestIcon } from '@phosphor-icons/react';
export function PRUpdateRenderer({ text, queued = false }: { text: string; queued?: boolean }) {
  const body = text.replace(/^<!-- factory-factory-pr-event:[^\n]+ -->\n?/, '');
  return (
    <div className="rounded-md border bg-muted/40 p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <GitPullRequestIcon className="h-4 w-4" />
        PR update{queued ? ' · queued for next turn' : ''}
      </div>
      <details>
        <summary className="text-sm cursor-pointer">View update</summary>
        <p className="mt-2 text-sm whitespace-pre-wrap break-words">{body}</p>
      </details>
    </div>
  );
}
