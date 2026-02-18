import {
  ArrowRightLeft,
  FileCode,
  FileMinus,
  FilePlus,
  FileQuestion,
  type LucideIcon,
} from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import type {
  CodexFileChangeEntry,
  CodexFileChangeKind,
  CodexFileChangePayload,
} from './file-change-parser';

const MAX_VISIBLE_CHANGES = 8;
const DIFF_PREVIEW_TRUNCATE = 4000;
const RAW_PAYLOAD_TRUNCATE = 12_000;

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.slice(0, maxLength)}\n... (truncated)`;
}

function getKindLabel(kind: CodexFileChangeKind): string {
  switch (kind) {
    case 'create':
      return 'Added';
    case 'update':
      return 'Modified';
    case 'delete':
      return 'Deleted';
    case 'move':
      return 'Moved';
    case 'unknown':
      return 'Changed';
  }
}

function getKindMeta(kind: CodexFileChangeKind): {
  icon: LucideIcon;
  className: string;
  iconColorClass: string;
} {
  switch (kind) {
    case 'create':
      return {
        icon: FilePlus,
        className: 'text-success border-success/40 bg-success/10',
        iconColorClass: 'text-success',
      };
    case 'update':
      return {
        icon: FileCode,
        className: 'text-yellow-600 border-yellow-500/40 bg-yellow-500/10',
        iconColorClass: 'text-yellow-600',
      };
    case 'delete':
      return {
        icon: FileMinus,
        className: 'text-destructive border-destructive/40 bg-destructive/10',
        iconColorClass: 'text-destructive',
      };
    case 'move':
      return {
        icon: ArrowRightLeft,
        className: 'text-sky-600 border-sky-500/40 bg-sky-500/10',
        iconColorClass: 'text-sky-600',
      };
    case 'unknown':
      return {
        icon: FileQuestion,
        className: 'text-muted-foreground border-border bg-muted/50',
        iconColorClass: 'text-muted-foreground',
      };
  }
}

function splitPath(path: string): { directory: string; filename: string } {
  const parts = path.split('/');
  const filename = parts[parts.length - 1] ?? path;
  return {
    filename,
    directory: parts.slice(0, -1).join('/'),
  };
}

function buildKindCounts(
  changes: CodexFileChangeEntry[]
): Array<{ kind: CodexFileChangeKind; count: number }> {
  const counts = new Map<CodexFileChangeKind, number>();
  for (const change of changes) {
    counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  }

  const orderedKinds: CodexFileChangeKind[] = ['create', 'update', 'delete', 'move', 'unknown'];
  return orderedKinds
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0 }))
    .filter((entry) => entry.count > 0);
}

interface CodexFileChangeRendererProps {
  payload: CodexFileChangePayload;
  rawPayload?: string;
}

export const CodexFileChangeRenderer = memo(function CodexFileChangeRenderer({
  payload,
  rawPayload,
}: CodexFileChangeRendererProps) {
  const visibleChanges = payload.changes.slice(0, MAX_VISIBLE_CHANGES);
  const remainingCount = Math.max(0, payload.changes.length - visibleChanges.length);
  const kindCounts = buildKindCounts(payload.changes);
  const raw = rawPayload ?? payload.rawText;

  return (
    <div className="space-y-2 w-0 min-w-full">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs">
          <FileCode className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">
            {payload.changes.length} file {payload.changes.length === 1 ? 'change' : 'changes'}
          </span>
          {payload.status && (
            <span className="ml-auto rounded border bg-muted/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {payload.status}
            </span>
          )}
        </div>
        {kindCounts.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {kindCounts.map(({ kind, count }) => {
              const meta = getKindMeta(kind);
              return (
                <span
                  key={`${kind}-${count}`}
                  className={cn(
                    'rounded border px-1.5 py-0.5 text-[10px] font-medium',
                    meta.className
                  )}
                >
                  {count} {getKindLabel(kind)}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {visibleChanges.length === 0 ? (
        <div className="rounded border bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">
          No file paths were included in this payload.
        </div>
      ) : (
        <div className="space-y-1.5">
          {visibleChanges.map((change, index) => {
            const meta = getKindMeta(change.kind);
            const Icon = meta.icon;
            const { directory, filename } = splitPath(change.path);

            return (
              <div
                key={`${change.path}-${index}`}
                className="rounded border bg-muted/20 px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <Icon className={cn('h-4 w-4 shrink-0', meta.iconColorClass)} />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs truncate" title={change.path}>
                      {filename}
                    </div>
                    {directory && (
                      <div className="text-[10px] text-muted-foreground truncate" title={directory}>
                        {directory}
                      </div>
                    )}
                  </div>
                  <span
                    className={cn(
                      'rounded border px-1 py-0.5 text-[10px] font-medium',
                      meta.className
                    )}
                  >
                    {getKindLabel(change.kind)}
                  </span>
                </div>
                {change.movePath && (
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                    <ArrowRightLeft className="h-3 w-3 shrink-0" />
                    <span className="font-mono truncate" title={change.movePath}>
                      {change.movePath}
                    </span>
                  </div>
                )}
                {change.diff && (
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      Diff preview
                    </summary>
                    <pre className="mt-1 overflow-x-auto max-h-36 overflow-y-auto rounded bg-muted px-1.5 py-1">
                      {truncateContent(change.diff, DIFF_PREVIEW_TRUNCATE)}
                    </pre>
                  </details>
                )}
              </div>
            );
          })}

          {remainingCount > 0 && (
            <div className="text-[10px] text-muted-foreground">
              +{remainingCount} more file {remainingCount === 1 ? 'change' : 'changes'}
            </div>
          )}
        </div>
      )}

      {raw && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Raw payload
          </summary>
          <pre className="mt-1 overflow-x-auto max-h-40 overflow-y-auto rounded bg-muted px-1.5 py-1">
            {truncateContent(raw, RAW_PAYLOAD_TRUNCATE)}
          </pre>
        </details>
      )}
    </div>
  );
});
