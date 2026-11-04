import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleDashedIcon } from '@phosphor-icons/react/dist/csr/CircleDashed';
import { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
import { GitMergeIcon } from '@phosphor-icons/react/dist/csr/GitMerge';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { ProhibitIcon } from '@phosphor-icons/react/dist/csr/Prohibit';
import { XCircleIcon } from '@phosphor-icons/react/dist/csr/XCircle';
import type { Icon } from '@phosphor-icons/react/dist/lib/types';
import { getPrStatePresentation, getStatusToneStyle } from '@/client/lib/status-tones';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PRState } from '@/shared/core';
import type { WorkspacePullRequest } from '@/shared/workspace-pr';

const STATE_ICONS: Record<PRState, Icon> = {
  NONE: ClockIcon,
  OPEN: GitPullRequestIcon,
  DRAFT: CircleDashedIcon,
  APPROVED: CheckCircleIcon,
  CHANGES_REQUESTED: XCircleIcon,
  MERGED: GitMergeIcon,
  CLOSED: ProhibitIcon,
};

/** One focusable tooltip per state; counts keep multi-PR cards compact. */
export function KanbanPrStates({ prs }: { prs: readonly WorkspacePullRequest[] }) {
  const groups = new Map<PRState, WorkspacePullRequest[]>();
  for (const pr of prs) {
    const group = groups.get(pr.state) ?? [];
    group.push(pr);
    groups.set(pr.state, group);
  }
  return [...groups].map(([state, group]) => {
    const presentation = getPrStatePresentation(state) ?? { tone: 'neutral', label: 'Syncing' };
    const StateIcon = STATE_ICONS[state];
    const label = `${group.map((pr) => (pr.number ? `#${pr.number}` : pr.url)).join(', ')}: ${presentation.label}`;
    return (
      <Tooltip key={state}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              'pointer-events-auto inline-flex items-center gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
              getStatusToneStyle(presentation.tone).text
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <StateIcon aria-hidden="true" className="h-3.5 w-3.5" />
            {group.length > 1 && <span className="text-[10px] font-medium">{group.length}</span>}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-words">{label}</TooltipContent>
      </Tooltip>
    );
  });
}
