import { FileCode, FileMinus, FilePlus, FileQuestion } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';

export type FileChangeKind = 'modified' | 'added' | 'deleted' | 'untracked';

export function fileChangeKindFromGitStatus(status: 'M' | 'A' | 'D' | '?'): FileChangeKind {
  switch (status) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case '?':
      return 'untracked';
  }
}

export function fileChangeKindFromDiffStatus(
  status: 'added' | 'modified' | 'deleted'
): FileChangeKind {
  switch (status) {
    case 'added':
      return 'added';
    case 'modified':
      return 'modified';
    case 'deleted':
      return 'deleted';
  }
}

function getStatusIcon(kind: FileChangeKind) {
  switch (kind) {
    case 'modified':
      return <FileCode className="h-4 w-4" />;
    case 'added':
      return <FilePlus className="h-4 w-4" />;
    case 'deleted':
      return <FileMinus className="h-4 w-4" />;
    case 'untracked':
      return <FileQuestion className="h-4 w-4" />;
  }
}

function getStatusColorClass(kind: FileChangeKind): string {
  switch (kind) {
    case 'modified':
      return 'text-yellow-500';
    case 'added':
      return 'text-green-500';
    case 'deleted':
      return 'text-red-500';
    case 'untracked':
      return 'text-muted-foreground';
  }
}

function getStatusLabel(kind: FileChangeKind): string {
  switch (kind) {
    case 'modified':
      return 'Modified';
    case 'added':
      return 'Added';
    case 'deleted':
      return 'Deleted';
    case 'untracked':
      return 'Untracked';
  }
}

interface FileChangeItemProps {
  path: string;
  kind: FileChangeKind;
  onClick: () => void;
  statusCode?: string;
  showIndicatorDot?: boolean;
}

export const FileChangeItem = memo(function FileChangeItem({
  path,
  kind,
  onClick,
  statusCode,
  showIndicatorDot = false,
}: FileChangeItemProps) {
  const statusColor = getStatusColorClass(kind);
  const fileName = path.split('/').pop() ?? path;
  const dirPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left',
        'hover:bg-muted/50 rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      title={`${getStatusLabel(kind)}: ${path}${showIndicatorDot ? ' (staged or not pushed to remote)' : ''}`}
    >
      <span className={statusColor}>{getStatusIcon(kind)}</span>
      <span className="flex-1 truncate">
        <span className="font-medium">{fileName}</span>
        {dirPath && <span className="text-muted-foreground ml-1 text-xs">{dirPath}</span>}
      </span>
      {showIndicatorDot && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-sky-500 shrink-0"
          title="Staged or not pushed to remote"
        />
      )}
      {statusCode && (
        <span className={cn('text-xs font-mono uppercase', statusColor)}>{statusCode}</span>
      )}
    </button>
  );
});
