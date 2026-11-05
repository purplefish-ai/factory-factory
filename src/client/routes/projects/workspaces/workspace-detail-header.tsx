import { memo } from 'react';
import {
  HeaderLeftExtraSlot,
  HeaderLeftStartSlot,
  HeaderRightSlot,
  HeaderRightEndSlot,
  useAppHeader,
} from '@/client/components/app-header-context';
import { ProjectHeaderNavigation } from '@/client/components/project-header';
import {
  RunScriptButton,
  RunScriptPortBadge,
  WorkspaceParentLink,
  WorkspaceFamilyMenu,
} from '@/client/features/workspace';
import { runInBackground } from '@/client/lib/background-task';
import { trpc } from '@/client/lib/trpc';
import { useIsMobile } from '@/hooks/use-mobile';
import { useWorkspaceProjectNavigation } from './use-workspace-project-navigation';
import {
  getWorkspaceHeaderLabel,
  ToggleRightPanelButton,
  WorkspaceHeaderOverflowMenu,
  type WorkspaceHeaderProps,
  WorkspaceIssueLink,
  WorkspacePrAction,
  WorkspacePrChip,
  WorkspaceSwitcherDropdown,
} from './workspace-detail-header/index';

/**
 * Component that injects workspace header content into the app-level header
 * via portal slots. Rendered inside WorkspaceDetailContainer.
 *
 * Inline controls are the ones used on most visits: the dev server, the PR chip
 * (with Create PR before a PR exists), and at wide widths the issue and port.
 * Everything else, including rename, details, provider settings, the GitHub
 * branch and archive, lives in "More actions" at every width. Controls
 * that collapse into that menu carry `data-header-inline` so the menu only
 * repeats them when they are hidden. The IDE action stays in the menu at every
 * width.
 */
export const WorkspaceDetailHeaderSlot = memo(function WorkspaceDetailHeaderSlot({
  workspace,
  workspaceId,
  availableIdes,
  preferredIde,
  openInIde,
  archivePending,
  onArchiveRequest,
  handleQuickAction,
  running,
  isCreatingSession,
  hasChanges,
}: WorkspaceHeaderProps) {
  const isMobile = useIsMobile();
  const { slug, projects } = useWorkspaceProjectNavigation();
  const routeProject = trpc.project.getBySlug.useQuery({ slug }, { enabled: !!slug });

  const isArchived = workspace.status === 'ARCHIVED' || workspace.status === 'ARCHIVING';
  const hasFamily = Boolean(workspace.parentWorkspace || workspace.childWorkspaceCount);
  const runQuickAction = (name: string, prompt: string) => {
    runInBackground(handleQuickAction(name, prompt), "Couldn't run quick action.");
  };
  const prAction = (renderAsMenuItem: boolean) => (
    <WorkspacePrAction
      renderAsMenuItem={renderAsMenuItem}
      workspace={workspace}
      hasChanges={hasChanges}
      running={running}
      isCreatingSession={isCreatingSession}
      handleQuickAction={runQuickAction}
    />
  );

  useAppHeader({ title: '' });

  return (
    <>
      <HeaderLeftStartSlot>
        <div data-workspace-header className="flex min-w-0 flex-1 items-center gap-0.5">
          <div
            className={
              hasFamily
                ? 'min-w-[74px] max-w-[25%] shrink md:min-w-0'
                : 'min-w-0 max-w-[50%] shrink md:max-w-[40%]'
            }
          >
            <ProjectHeaderNavigation
              showTrailingSlash
              triggerId="workspace-detail-project-select"
              project={
                routeProject.data ??
                projects?.find((candidate) => candidate.slug === slug) ?? {
                  id: workspace.projectId,
                  slug,
                  name: slug,
                }
              }
            />
          </div>
          {workspace.parentWorkspace && (
            <WorkspaceParentLink
              parent={workspace.parentWorkspace}
              projectId={workspace.projectId}
              breadcrumb
            />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-0.5">
            <WorkspaceSwitcherDropdown
              projectSlug={slug}
              projectId={workspace.projectId}
              currentWorkspaceId={workspaceId}
              compact={hasFamily}
              currentWorkspaceLabel={
                workspace.parentWorkspace
                  ? workspace.name
                  : getWorkspaceHeaderLabel(workspace.branchName, workspace.name, isMobile)
              }
              currentWorkspaceName={workspace.name}
            />
          </div>
          {hasFamily && (
            <WorkspaceFamilyMenu
              key={workspaceId}
              workspace={workspace}
              projectSlug={slug}
              iconOnly={isMobile}
            />
          )}
        </div>
      </HeaderLeftStartSlot>
      <HeaderLeftExtraSlot>
        <div className="hidden @[72rem]/header:flex shrink-0 items-center gap-2">
          <div data-header-inline="issue" className="flex">
            <WorkspaceIssueLink workspace={workspace} />
          </div>
          <RunScriptPortBadge workspaceId={workspaceId} />
        </div>
      </HeaderLeftExtraSlot>
      <HeaderRightSlot>
        <div className="flex shrink-0 items-center gap-0.5">
          <RunScriptButton workspaceId={workspaceId} />
          <div data-header-inline="create-pr" className="hidden @[48rem]/header:flex">
            {prAction(false)}
          </div>
          <WorkspacePrChip workspace={workspace} workspaceId={workspaceId} />
          <WorkspaceHeaderOverflowMenu
            isArchived={isArchived}
            workspace={workspace}
            workspaceId={workspaceId}
            availableIdes={availableIdes}
            preferredIde={preferredIde}
            openInIde={openInIde}
            archivePending={archivePending}
            onArchiveRequest={onArchiveRequest}
            statusContent={(isInline) => (
              <>
                {!isInline('create-pr') && prAction(true)}
                {!isInline('issue') && (
                  <WorkspaceIssueLink workspace={workspace} renderAsMenuItem />
                )}
              </>
            )}
          />
        </div>
      </HeaderRightSlot>
      <HeaderRightEndSlot>
        <ToggleRightPanelButton />
      </HeaderRightEndSlot>
    </>
  );
});
