import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { StatusChip, StatusDot } from '@/client/components/status-indicators';
import {
  ConnectedWorkspacePrMenu,
  getPrChipStatus,
  getRatchetStateLabel,
  RatchetWrenchIcon,
} from '@/client/features/workspace';
import { getWorkspaceSelectedPR } from '@/client/lib/workspace-selected-pr';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { WorkspaceHeaderWorkspace } from './types';

function describePrChip(workspace: WorkspaceHeaderWorkspace) {
  const enabled = workspace.ratchetEnabled ?? false;
  const updates = enabled ? `on (${getRatchetStateLabel(workspace.ratchetState)})` : 'off';
  const pr = getWorkspaceSelectedPR(workspace);
  const others = Math.max(0, workspace.prs.length - 1);
  const prSummary = pr
    ? `${pr.number ? `#${pr.number}` : 'PR'} ${getPrChipStatus(pr).label}${others ? ` and ${others} more` : ''}`
    : null;
  return { prSummary, updates };
}

/** The chip's accessible name. */
export function getWorkspacePrChipLabel(workspace: WorkspaceHeaderWorkspace): string {
  const { prSummary, updates } = describePrChip(workspace);
  return `Pull requests and updates: ${prSummary ?? 'no PR'}, updates ${updates}`;
}

function getWorkspacePrChipTooltip(workspace: WorkspaceHeaderWorkspace): string {
  const { prSummary, updates } = describePrChip(workspace);
  return `${prSummary ? `PR ${prSummary}` : 'No pull request'} · PR updates ${updates}`;
}

/**
 * The header's PR control: "#123" with the state that most needs attention
 * (CI, review, merged), in the same tones as the sidebar and board. The wrench
 * shows whether PR updates are on; the menu lists every PR and holds the
 * updates toggle, delivery options and Add PR.
 */
export function WorkspacePrChip({
  workspace,
  workspaceId,
}: {
  workspace: WorkspaceHeaderWorkspace;
  workspaceId: string;
}) {
  const enabled = workspace.ratchetEnabled ?? false;
  const readOnly = workspace.status === 'ARCHIVED' || workspace.status === 'ARCHIVING';
  const pr = getWorkspaceSelectedPR(workspace);
  const status = pr ? getPrChipStatus(pr) : null;
  const others = Math.max(0, workspace.prs.length - 1);
  const label = getWorkspacePrChipLabel(workspace);
  return (
    <Tooltip>
      <ConnectedWorkspacePrMenu
        key={workspaceId}
        workspaceId={workspaceId}
        projectId={workspace.projectId}
        prs={workspace.prs}
        monitoring={workspace.prMonitoring}
        readOnly={readOnly}
        reviewEnabled={Boolean(workspace.worktreePath)}
        trigger={
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="compact"
              className="max-w-[16rem] gap-1 px-1.5 data-[state=open]:bg-accent @[48rem]/header:gap-1.5 @[48rem]/header:px-2"
              aria-label={label}
            >
              <RatchetWrenchIcon
                enabled={enabled}
                animated={workspace.ratchetButtonAnimated ?? false}
              />
              {pr && status ? (
                <>
                  <span className="font-medium tabular-nums">
                    {pr.number ? `#${pr.number}` : 'PR'}
                  </span>
                  <StatusDot tone={status.tone} className="@[48rem]/header:hidden" />
                  <StatusChip
                    tone={status.tone}
                    className="hidden min-w-0 truncate @[48rem]/header:inline-flex"
                  >
                    {status.label}
                  </StatusChip>
                  {others > 0 && <span className="text-muted-foreground">+{others}</span>}
                </>
              ) : (
                <span className="text-muted-foreground">No PR</span>
              )}
              <CaretDownIcon className="hidden shrink-0 text-muted-foreground @[48rem]/header:block" />
            </Button>
          </TooltipTrigger>
        }
      />
      <TooltipContent>{getWorkspacePrChipTooltip(workspace)}</TooltipContent>
    </Tooltip>
  );
}
