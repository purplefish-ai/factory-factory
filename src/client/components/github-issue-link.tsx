import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { getStatusToneStyle } from '@/client/lib/status-tones';
import { trpc } from '@/client/lib/trpc';
import { type GitHubIssuePreview, parseGitHubIssueLink } from '@/shared/github-issue-preview';
import {
  GitHubPreviewFrame,
  GitHubPreviewTooltip,
  githubPreviewQueryOptions,
} from './github-link-preview';

// GitHub shows open issues in green and closed (completed) issues in purple.
const ISSUE_STATES = {
  OPEN: { label: 'Open', color: getStatusToneStyle('success').chip },
  CLOSED: { label: 'Closed', color: getStatusToneStyle('merged').chip },
};

export function GitHubIssuePreviewCard({
  repo,
  number,
  data,
  isError = false,
}: {
  repo: string;
  number: number;
  data?: GitHubIssuePreview;
  isError?: boolean;
}) {
  const state = data ? ISSUE_STATES[data.state] : null;
  const Icon = data?.state === 'CLOSED' ? CheckCircleIcon : CircleIcon;
  return (
    <GitHubPreviewFrame
      repo={repo}
      number={number}
      kind="issue"
      data={data}
      state={state}
      icon={<Icon className="size-3.5" aria-hidden="true" />}
      isError={isError}
    />
  );
}

function IssuePreview({ repo, number }: { repo: string; number: number }) {
  const { data, isError } = trpc.github.getIssuePreview.useQuery(
    { repo: repo.toLowerCase(), number },
    githubPreviewQueryOptions
  );
  return <GitHubIssuePreviewCard repo={repo} number={number} data={data} isError={isError} />;
}

export function GitHubIssueLink({ link }: { link: ReactElement<ComponentPropsWithoutRef<'a'>> }) {
  const issue = link.props.href ? parseGitHubIssueLink(link.props.href) : null;
  if (!issue) {
    return link;
  }
  return (
    <GitHubPreviewTooltip link={link}>
      <IssuePreview {...issue} />
    </GitHubPreviewTooltip>
  );
}
