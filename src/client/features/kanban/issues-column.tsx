import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { useMemo } from 'react';
import { ProjectIssuesState } from '@/client/components/project-issues-state';
import type { NormalizedIssue } from '@/client/lib/issue-normalization';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import { InlineWorkspaceForm } from './inline-workspace-form';
import { IssueCard } from './issue-card';
import type { ColumnConfig } from './kanban-column';
import { useKanban } from './kanban-context';

// Separate component for the Issues column
interface IssuesColumnProps {
  column: ColumnConfig;
  issues: NormalizedIssue[];
  projectId: string;
  onWorkspaceCreated?: () => void;
  filtered?: boolean;
}

export function IssuesColumn({
  column,
  issues,
  projectId,
  onWorkspaceCreated,
  filtered,
}: IssuesColumnProps) {
  const {
    workspaces,
    showInlineForm,
    setShowInlineForm,
    requestInlineForm,
    issuesStatus,
    isFetchingIssues,
    issuesError,
    refetchIssues,
    projectSlug,
  } = useKanban();
  const existingNames = useMemo(() => workspaces?.map((w) => w.name) ?? [], [workspaces]);
  const isEmpty = issues.length === 0;
  const isMobile = useIsMobile();

  return (
    <div
      data-todo-column
      className="flex flex-col w-full md:flex-1 md:min-w-[280px] md:max-w-[440px] md:h-full"
    >
      {/* Column header and mobile section heading */}
      <div className="flex h-13 shrink-0 items-center justify-between px-3 py-3 bg-muted/50 rounded-t-lg">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">{column.label}</h3>
          <Badge variant="secondary" className="h-5 min-w-5 justify-center text-xs">
            {issues.length}
          </Badge>
        </div>
      </div>

      {/* Column Content */}
      <div className="flex flex-col gap-3 flex-1 md:overflow-y-auto p-3 min-h-0 rounded-lg md:rounded-t-none bg-muted/50">
        {!(isMobile || showInlineForm) && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 w-full justify-start"
            onClick={requestInlineForm}
          >
            <PlusIcon className="h-4 w-4" />
            New workspace
          </Button>
        )}
        {showInlineForm ? (
          <InlineWorkspaceForm
            key={projectId}
            projectId={projectId}
            existingNames={existingNames}
            onCancel={() => setShowInlineForm(false)}
            onCreated={() => {
              setShowInlineForm(false);
              onWorkspaceCreated?.();
            }}
          />
        ) : null}
        {(isEmpty || issuesStatus === 'error') && (
          <ProjectIssuesState
            status={issuesStatus}
            isRetrying={isFetchingIssues}
            filtered={filtered}
            error={issuesError}
            projectSlug={projectSlug}
            onRetry={refetchIssues}
          />
        )}
        {!isEmpty &&
          issues.map((issue) => (
            <div key={issue.id} className="shrink-0">
              <IssueCard issue={issue} projectId={projectId} />
            </div>
          ))}
      </div>
    </div>
  );
}
