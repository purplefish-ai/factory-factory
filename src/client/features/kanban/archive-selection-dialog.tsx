import { StatusCallout } from '@/client/components/status-callout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import type { WorkspaceWithKanban } from './kanban-card';

type ArchiveRiskWorkspace = Pick<
  WorkspaceWithKanban,
  'name' | 'isWorking' | 'gitStats' | 'prSummary' | 'runScriptStatus' | 'childWorkspaceCount'
>;

export interface ArchiveRisk {
  label: string;
  names: string[];
}

/** Run-script states with a live process that archiving stops. */
const ACTIVE_RUN_SCRIPT_STATUSES: ReadonlySet<string> = new Set([
  'STARTING',
  'RUNNING',
  'STOPPING',
]);

const RISKS: { label: string; applies: (workspace: ArchiveRiskWorkspace) => boolean }[] = [
  { label: 'Agent running', applies: (workspace) => workspace.isWorking },
  {
    label: 'Uncommitted changes',
    applies: (workspace) => workspace.gitStats?.hasUncommitted === true,
  },
  { label: 'Open pull request', applies: (workspace) => workspace.prSummary.openCount > 0 },
  {
    label: 'Dev server running',
    applies: (workspace) => ACTIVE_RUN_SCRIPT_STATUSES.has(workspace.runScriptStatus),
  },
  {
    label: 'Has child workspaces, which stay active',
    applies: (workspace) => (workspace.childWorkspaceCount ?? 0) > 0,
  },
];

/**
 * What archiving these workspaces could lose or interrupt, from the list data
 * the board already has. It runs no git commands, so unpushed commits are not
 * known here.
 */
export function summarizeArchiveRisks(workspaces: readonly ArchiveRiskWorkspace[]): ArchiveRisk[] {
  return RISKS.map(({ label, applies }) => ({
    label,
    names: workspaces.filter(applies).map((workspace) => workspace.name),
  })).filter((risk) => risk.names.length > 0);
}

const MAX_NAMES = 3;

function formatNames(names: readonly string[]) {
  const shown = names.slice(0, MAX_NAMES).join(', ');
  return names.length > MAX_NAMES ? `${shown} and ${names.length - MAX_NAMES} more` : shown;
}

export interface ArchiveSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Exactly the workspaces that confirming archives. */
  workspaces: readonly ArchiveRiskWorkspace[];
  /** A sentence placed before the shared consequences, such as which cards are included. */
  scope?: string;
  onConfirm: () => void;
}

/**
 * Confirms archiving several workspaces. Like the single-workspace dialog,
 * confirming closes it at once; the cards leave the board while the archive
 * runs.
 */
export function ArchiveSelectionDialog({
  open,
  onOpenChange,
  workspaces,
  scope,
  onConfirm,
}: ArchiveSelectionDialogProps) {
  const count = workspaces.length;
  const noun = count === 1 ? 'workspace' : 'workspaces';
  const risks = summarizeArchiveRisks(workspaces);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Archive ${count} ${noun}?`}
      description={`${scope ? `${scope} ` : ''}Running agents and processes will stop. Uncommitted changes will be committed before ${count === 1 ? 'the worktree is' : 'the worktrees are'} removed. Chat history and ${count === 1 ? 'the branch are' : 'branches are'} kept. Worktree removal cannot be undone in the app.`}
      confirmText={`Archive ${count}`}
      variant="destructive"
      onConfirm={() => {
        onConfirm();
        onOpenChange(false);
      }}
    >
      {risks.length > 0 && (
        <StatusCallout tone="warning" title="Check before archiving">
          <ul className="list-disc space-y-0.5 pl-4">
            {risks.map((risk) => (
              <li key={risk.label}>
                {risk.label} ({risk.names.length}): {formatNames(risk.names)}
              </li>
            ))}
          </ul>
        </StatusCallout>
      )}
    </ConfirmDialog>
  );
}
