import { GitMergeIcon } from '@phosphor-icons/react/dist/csr/GitMerge';
import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import {
  DIFF_STAT_CLASS_NAMES,
  getPrStatePresentation,
  getStatusToneStyle,
} from '@/client/lib/status-tones';
import { trpc } from '@/client/lib/trpc';
import { type GitHubPRPreview, parseGitHubPRLink } from '@/shared/github-pr-preview';
import {
  GitHubPreviewFrame,
  GitHubPreviewTooltip,
  githubPreviewQueryOptions,
} from './github-link-preview';

function getPreviewState(data: GitHubPRPreview): { label: string; color: string } | null {
  const presentation = getPrStatePresentation(
    data.state === 'OPEN' && data.isDraft ? 'DRAFT' : data.state
  );
  return presentation
    ? { label: presentation.label, color: getStatusToneStyle(presentation.tone).chip }
    : null;
}

export function GitHubPRPreviewCard({
  repo,
  number,
  data,
  isError = false,
}: {
  repo: string;
  number: number;
  data?: GitHubPRPreview;
  isError?: boolean;
}) {
  const state = data ? getPreviewState(data) : null;
  const Icon = data?.state === 'MERGED' ? GitMergeIcon : GitPullRequestIcon;
  return (
    <GitHubPreviewFrame
      repo={repo}
      number={number}
      kind="pull request"
      data={data}
      state={state}
      icon={<Icon className="size-3.5" aria-hidden="true" />}
      isError={isError}
    >
      {data && (
        <span className="flex items-center gap-2 tabular-nums">
          <span className="rounded-md bg-muted px-2 py-1">
            <span className={DIFF_STAT_CLASS_NAMES.added}>+{data.additions.toLocaleString()}</span>{' '}
            <span className={DIFF_STAT_CLASS_NAMES.removed}>
              −{data.deletions.toLocaleString()}
            </span>
          </span>
          <span className="rounded-md bg-muted px-2 py-1">
            {data.changedFiles} {data.changedFiles === 1 ? 'file' : 'files'}
          </span>
        </span>
      )}
    </GitHubPreviewFrame>
  );
}

function PRPreview({ repo, number }: { repo: string; number: number }) {
  const { data, isError } = trpc.github.getPRPreview.useQuery(
    { repo: repo.toLowerCase(), number },
    githubPreviewQueryOptions
  );
  return <GitHubPRPreviewCard repo={repo} number={number} data={data} isError={isError} />;
}

export function GitHubPRLink({ link }: { link: ReactElement<ComponentPropsWithoutRef<'a'>> }) {
  const pr = link.props.href ? parseGitHubPRLink(link.props.href) : null;
  if (!pr) {
    return link;
  }
  return (
    <GitHubPreviewTooltip link={link}>
      <PRPreview {...pr} />
    </GitHubPreviewTooltip>
  );
}
