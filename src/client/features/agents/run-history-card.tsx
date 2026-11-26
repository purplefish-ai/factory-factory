import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { getProjectSectionPath } from '@/client/lib/project-navigation';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { WorkspaceStatus } from '@/shared/core';

interface RunHistoryCardProps {
  runId: string;
  workspaceStatus: WorkspaceStatus | null;
  header: ReactNode;
  children: ReactNode;
}

export function RunHistoryCard({ runId, workspaceStatus, header, children }: RunHistoryCardProps) {
  return (
    <Card
      role="article"
      data-run-id={runId}
      className={cn(
        'min-w-0 text-xs',
        (workspaceStatus === 'ARCHIVED' || workspaceStatus === 'ARCHIVING') && 'border-dashed'
      )}
    >
      <CardHeader className="pb-2">{header}</CardHeader>
      <CardContent className="min-w-0 space-y-2">{children}</CardContent>
    </Card>
  );
}

export function RunHistoryWorkspace({
  runId,
  projectSlug,
  workspaceId,
  workspaceStatus,
  missingLabel,
}: {
  runId: string;
  projectSlug: string;
  workspaceId: string | null;
  workspaceStatus: WorkspaceStatus | null;
  missingLabel: string;
}) {
  if (workspaceStatus === 'ARCHIVED' || workspaceStatus === 'ARCHIVING') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ArchiveIcon className="size-3 shrink-0" />
        {workspaceStatus === 'ARCHIVED' ? 'Workspace archived' : 'Workspace archiving'}
      </span>
    );
  }
  if (!workspaceId) {
    return <span className="text-muted-foreground">{missingLabel}</span>;
  }
  return (
    <Link
      to={`${getProjectSectionPath(projectSlug, 'workspaces')}/${encodeURIComponent(workspaceId)}`}
      className="font-medium text-primary underline underline-offset-4"
    >
      Open workspace <span className="sr-only">for run {runId}</span>
    </Link>
  );
}
