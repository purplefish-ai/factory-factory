import { CaretDownIcon, GitPullRequestIcon, PlusIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { CiStatusChip } from '@/client/components/ci-status-chip';
import { PrStateBadge } from '@/client/components/pr-state-badge';
import { useToggleRatcheting } from '@/client/hooks/use-toggle-ratcheting';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { PRDeliveryMode, type PRMonitoringProjection } from '@/shared/pr-monitoring';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';
import { PRMonitoringMenuItems, type PRMonitoringMenuProps } from './pr-monitoring-menu-items';
import { useWorkspacePrActions } from './use-workspace-pr-actions';

export function WorkspacePrMenu({
  prs,
  onAdd,
  onRemove,
  onReview,
  pending = false,
  compact = false,
  monitoring,
}: {
  prs: readonly WorkspacePullRequest[];
  onAdd?: () => void;
  onRemove?: (prId: string) => void;
  onReview?: (prId: string) => void;
  pending?: boolean;
  compact?: boolean;
  monitoring?: PRMonitoringMenuProps;
}) {
  const ordered = [...prs].sort(
    (a, b) =>
      Number(['MERGED', 'CLOSED'].includes(a.state)) -
        Number(['MERGED', 'CLOSED'].includes(b.state)) || a.url.localeCompare(b.url)
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`PRs (${prs.length})`}
          className={compact ? 'h-5 gap-1 px-0 text-[11px]' : 'h-7 gap-1 px-2 text-xs'}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          <GitPullRequestIcon className="h-3 w-3" />
          <span>
            {prs.length === 1 && prs[0]?.number
              ? `#${prs[0].number}`
              : `PRs${prs.length > 0 ? ` ${prs.length}` : ''}`}
          </span>
          <CaretDownIcon className="h-2.5 w-2.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionPadding={8}
        className="flex flex-col overflow-hidden w-80 max-w-[calc(100vw-1rem)]"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuLabel className="shrink-0 text-xs text-muted-foreground">
          Pull requests
        </DropdownMenuLabel>
        {!ordered.length && <p className="px-2 py-3 text-xs text-muted-foreground">No PRs yet</p>}
        <div className="min-h-0 max-h-80 overflow-y-auto">
          {ordered.map((pr) => (
            <WorkspacePrMenuRow
              key={pr.id}
              pr={pr}
              pending={pending}
              onReview={onReview}
              onRemove={onRemove}
            />
          ))}
        </div>
        {monitoring && <PRMonitoringMenuItems {...monitoring} />}
        {onAdd && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="shrink-0" disabled={pending} onSelect={onAdd}>
              <PlusIcon />
              Add PR
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function getPrCiState(pr: WorkspacePullRequest) {
  if (pr.state === 'MERGED' || pr.state === 'CLOSED') {
    return pr.state;
  }
  if (pr.hasMergeConflict) {
    return 'CONFLICT';
  }
  const states = {
    FAILURE: 'FAILING',
    SUCCESS: 'PASSING',
    PENDING: 'RUNNING',
    UNKNOWN: 'UNKNOWN',
  } as const;
  return states[pr.ciStatus];
}

function WorkspacePrMenuRow({
  pr,
  pending,
  onReview,
  onRemove,
}: {
  pr: WorkspacePullRequest;
  pending: boolean;
  onReview?: (prId: string) => void;
  onRemove?: (prId: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-xs" title={pr.title ?? pr.url}>
            {pr.number ? `#${pr.number} · ` : ''}
            {pr.title ??
              (pr.state === 'NONE' ? 'Syncing' : pr.url.split('/').slice(3, 5).join('/'))}
          </span>
          <span className="truncate text-[10px] text-muted-foreground">
            {pr.url.split('/').slice(3, 5).join('/')} {pr.headRefName && `· ${pr.headRefName}`}
          </span>
        </span>
        <PrStateBadge prState={pr.state} size="sm" />
        <CiStatusChip ciState={getPrCiState(pr)} prState={pr.state} size="sm" showTooltip={false} />
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent
          collisionPadding={8}
          className="max-sm:data-[side=right]:-translate-x-full max-sm:data-[side=left]:translate-x-full"
        >
          <DropdownMenuItem asChild>
            <a href={pr.url} target="_blank" rel="noopener noreferrer">
              Open on GitHub
            </a>
          </DropdownMenuItem>
          {onReview && (
            <DropdownMenuItem
              disabled={
                pending || pr.state === 'NONE' || pr.state === 'MERGED' || pr.state === 'CLOSED'
              }
              onSelect={() => onReview(pr.id)}
            >
              Run review
            </DropdownMenuItem>
          )}
          {onRemove && (
            <DropdownMenuItem disabled={pending} onSelect={() => onRemove(pr.id)}>
              Remove from workspace
            </DropdownMenuItem>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function ConnectedPRMonitoringMenu({
  workspaceId,
  projectId,
  prs,
  monitoring,
  compact,
  actions,
  onAdd,
  onRemove,
}: {
  workspaceId: string;
  projectId?: string;
  prs: readonly WorkspacePullRequest[];
  monitoring: PRMonitoringProjection;
  compact: boolean;
  actions: Omit<ReturnType<typeof useWorkspacePrActions>, 'review'> & {
    review?: (id: string) => void;
  };
  onAdd(): void;
  onRemove(id: string): void;
}) {
  const toggle = useToggleRatcheting(projectId);
  const deliveryMode = monitoring.deliveryMode ?? PRDeliveryMode.MAIN;
  return (
    <>
      {toggle.recipientPicker}
      <WorkspacePrMenu
        prs={prs}
        compact={compact}
        pending={actions.pending}
        onAdd={onAdd}
        onRemove={onRemove}
        onReview={actions.review}
        monitoring={{
          enabled: monitoring.enabled,
          deliveryMode,
          pending: toggle.isPending,
          pauseReason: monitoring.pauseReason,
          onResume: () =>
            toggle.mutate({
              workspaceId,
              enabled: true,
              resume: true,
              deliveryMode,
              expectedBindingRevision: monitoring.bindingRevision,
            }),
          onToggle: (enabled) => toggle.mutate({ workspaceId, enabled }),
          onDeliveryMode: (mode) =>
            toggle.mutate({
              workspaceId,
              enabled: monitoring.enabled,
              deliveryMode: mode,
              expectedBindingRevision: monitoring.bindingRevision,
            }),
          onChangeRecipient: () =>
            toggle.mutate({
              workspaceId,
              enabled: true,
              deliveryMode: PRDeliveryMode.MAIN,
              recipientSessionId: null,
            }),
        }}
      />
    </>
  );
}

export function ConnectedWorkspacePrMenu({
  workspaceId,
  projectId,
  prs,
  readOnly = false,
  monitoring,
  reviewEnabled = true,
  compact = false,
}: {
  workspaceId: string;
  projectId?: string;
  prs: readonly WorkspacePullRequest[];
  readOnly?: boolean;
  monitoring?: PRMonitoringProjection;
  reviewEnabled?: boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const actions = useWorkspacePrActions(workspaceId, projectId);
  const openAdd = () => {
    setUrl('');
    setError(null);
    setOpen(true);
  };
  return (
    <fieldset
      className="contents"
      aria-label="Pull request actions"
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      {monitoring && !readOnly ? (
        <ConnectedPRMonitoringMenu
          workspaceId={workspaceId}
          projectId={projectId}
          prs={prs}
          compact={compact}
          monitoring={monitoring}
          actions={{ ...actions, review: reviewEnabled ? actions.review : undefined }}
          onAdd={openAdd}
          onRemove={setRemoveId}
        />
      ) : (
        <WorkspacePrMenu
          prs={prs}
          compact={compact}
          pending={actions.pending}
          onAdd={readOnly ? undefined : openAdd}
          onRemove={readOnly ? undefined : setRemoveId}
          onReview={readOnly || !reviewEnabled ? undefined : actions.review}
        />
      )}
      <ConfirmDialog
        open={removeId !== null}
        onOpenChange={(value) => {
          if (!value) {
            setRemoveId(null);
          }
        }}
        title="Remove PR from workspace?"
        description="The pull request stays on GitHub. This workspace will stop watching it."
        confirmText="Remove"
        isPending={actions.pending}
        onConfirm={async () => {
          if (removeId && (await actions.remove(removeId))) {
            setRemoveId(null);
          }
        }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add PR</DialogTitle>
            <DialogDescription>
              Link a GitHub PR to receive updates in this workspace.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              setError(null);
              const result = await actions.add(url.trim());
              if (result.success) {
                setOpen(false);
                setUrl('');
              } else {
                setError(result.error);
              }
            }}
            className="space-y-3"
          >
            <Input
              aria-label="GitHub PR URL"
              type="url"
              required
              placeholder="https://github.com/owner/repo/pull/123"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoFocus
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={actions.pending || !url.trim()}>
                {actions.pending ? 'Adding…' : 'Add PR'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </fieldset>
  );
}
