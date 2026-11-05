import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileMinusIcon } from '@phosphor-icons/react/dist/csr/FileMinus';
import { FilePlusIcon } from '@phosphor-icons/react/dist/csr/FilePlus';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { FileTreeRow } from './file-tree-row';

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
      return <FileCodeIcon className="h-4 w-4" />;
    case 'added':
      return <FilePlusIcon className="h-4 w-4" />;
    case 'deleted':
      return <FileMinusIcon className="h-4 w-4" />;
    case 'untracked':
      return <FilePlusIcon className="h-4 w-4" />;
  }
}

function getStatusColorClass(kind: FileChangeKind): string {
  switch (kind) {
    case 'modified':
      return 'text-warning';
    case 'added':
      return 'text-success';
    case 'deleted':
      return 'text-destructive';
    case 'untracked':
      return 'text-success';
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

export function FileChangeStatus({
  kind,
  statusCode,
}: {
  kind: FileChangeKind;
  statusCode?: string;
}) {
  if (!statusCode) {
    return null;
  }
  return (
    <span
      className={cn(
        'text-xs font-mono',
        kind !== 'untracked' && 'uppercase',
        getStatusColorClass(kind)
      )}
      title={kind === 'untracked' ? 'Untracked: new file, not staged' : getStatusLabel(kind)}
    >
      {kind === 'untracked' ? 'New' : statusCode}
    </span>
  );
}

interface FileChangeItemProps {
  depth?: number;
  path: string;
  kind: FileChangeKind;
  onClick: () => void;
  statusCode?: string;
  showIndicatorDot?: boolean;
  indicatorLabel?: string;
  /** When false, hides the directory path suffix (used in tree view where dir context is shown by parent rows) */
  showDirPath?: boolean;
}

export const FileChangeItem = memo(function FileChangeItem({
  depth = 0,
  path,
  kind,
  onClick,
  statusCode,
  showIndicatorDot = false,
  indicatorLabel = 'Staged or not pushed to remote',
  showDirPath = true,
}: FileChangeItemProps) {
  const statusColor = getStatusColorClass(kind);
  const fileName = path.split('/').pop() ?? path;
  const dirPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

  return (
    <FileTreeRow
      onClick={onClick}
      depth={depth}
      title={`${getStatusLabel(kind)}: ${path}${showIndicatorDot ? ` (${indicatorLabel})` : ''}`}
      icon={<span className={statusColor}>{getStatusIcon(kind)}</span>}
      label={
        <>
          {fileName}
          {showDirPath && dirPath && (
            <span className="text-muted-foreground ml-1 text-xs">{dirPath}</span>
          )}
        </>
      }
    >
      {showIndicatorDot && (
        <span className="h-1.5 w-1.5 rounded-full bg-info shrink-0" title={indicatorLabel} />
      )}
      <FileChangeStatus kind={kind} statusCode={statusCode} />
    </FileTreeRow>
  );
});
