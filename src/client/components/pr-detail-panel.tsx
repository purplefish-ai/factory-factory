import { GitPullRequestIcon } from '@phosphor-icons/react/dist/csr/GitPullRequest';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { QueryErrorState } from '@/client/components/query-error-state';
import { useShortcut } from '@/client/features/shortcuts';
import { withOccurrenceKeys } from '@/client/lib/list-keys';
import {
  getMergeStatePresentation,
  getReviewStatePresentation,
} from '@/client/lib/pr-status-presentation';
import { DIFF_STAT_CLASS_NAMES } from '@/client/lib/status-tones';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  getSimpleDiffLineClassName,
  getSimpleDiffLinePrefix,
  parseFileDiff,
  type SimpleDiffLine,
} from '@/lib/diff';
import { formatDateTimeShort } from '@/lib/formatters';
import type { GitHubComment, PRWithFullDetails } from '@/shared/github-types';
import { EmptyState } from './empty-state';
import { Loading } from './loading';
import { CIChecksSection, CIStatusBadge, ReviewDecisionBadge } from './pr-status-badges';
import { StatusChip } from './status-indicators';

interface PRDetailPanelProps {
  pr: PRWithFullDetails | null;
  diff: string | null;
  diffLoading: boolean;
  diffError?: string | null;
  onFetchDiff: () => void;
  onOpenGitHub: () => void;
  onApprove: () => void;
  approving?: boolean;
}

type Tab = 'info' | 'diff';

function getApproveButtonText(approving: boolean, reviewDecision: string | null): string {
  if (approving) {
    return 'Approving…';
  }
  if (reviewDecision === 'APPROVED') {
    return 'Approved';
  }
  return 'Approve';
}

function DiffLineRow({ line }: { line: SimpleDiffLine }) {
  return (
    <div className={`px-3 whitespace-pre ${getSimpleDiffLineClassName(line.type)}`}>
      <span className="select-none opacity-50 mr-2">{getSimpleDiffLinePrefix(line.type)}</span>
      {line.content}
    </div>
  );
}

function DiffViewer({ diff }: { diff: string }) {
  const files = parseFileDiff(diff);

  return (
    <div className="divide-y">
      {files.map((file) => (
        <div key={file.name} className="text-xs">
          <div className="px-3 py-1.5 bg-muted/50 font-mono sticky top-0 flex items-center gap-2">
            <span data-testid="diff-file-name" className="font-medium truncate">
              {file.name}
            </span>
            {file.additions > 0 && (
              <span className={DIFF_STAT_CLASS_NAMES.added}>+{file.additions}</span>
            )}
            {file.deletions > 0 && (
              <span className={DIFF_STAT_CLASS_NAMES.removed}>-{file.deletions}</span>
            )}
          </div>
          <div className="font-mono text-xs leading-tight overflow-x-auto">
            {file.hunks.map((hunk) => (
              <div key={hunk.header}>
                <div className="px-3 py-1 bg-info/10 text-info text-xs">{hunk.header}</div>
                {withOccurrenceKeys(hunk.lines, (line) =>
                  JSON.stringify([line.type, line.content])
                ).map(({ item: line, key }) => (
                  <DiffLineRow key={key} line={line} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Sub-components for better organization
interface PRHeaderProps {
  pr: PRWithFullDetails;
}

function PRHeader({ pr }: PRHeaderProps) {
  return (
    <div className="px-4 py-3 border-b bg-muted/30 flex-shrink-0">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <Badge variant="secondary" className="font-mono text-xs">
          {pr.repository.nameWithOwner}
        </Badge>
        <span className="text-xs text-muted-foreground">→ {pr.baseRefName}</span>
      </div>
      <h2 className="font-semibold leading-tight line-clamp-2 text-sm">{pr.title}</h2>
      {pr.labels && pr.labels.length > 0 && (
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {pr.labels.map((label) => (
            <span
              key={label.name}
              className="text-xs px-1.5 py-0.5 rounded"
              style={{
                backgroundColor: `#${label.color}20`,
                color: `#${label.color}`,
              }}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface PRStatsProps {
  pr: PRWithFullDetails;
}

function PRStats({ pr }: PRStatsProps) {
  const mergeState = getMergeStatePresentation(pr.mergeStateStatus);
  return (
    <div className="px-4 py-2 border-b flex items-center gap-2 text-xs flex-shrink-0 flex-wrap">
      <span>
        <strong>{pr.changedFiles}</strong> files
      </span>
      <span className={DIFF_STAT_CLASS_NAMES.added}>
        <strong>+{pr.additions}</strong>
      </span>
      <span className={DIFF_STAT_CLASS_NAMES.removed}>
        <strong>-{pr.deletions}</strong>
      </span>
      <span className="flex-1 min-w-0" />
      <CIStatusBadge checks={pr.statusCheckRollup} />
      <ReviewDecisionBadge decision={pr.reviewDecision} />
      <StatusChip tone={mergeState.tone} size="md">
        {mergeState.label}
      </StatusChip>
    </div>
  );
}

interface PRReviewsProps {
  pr: PRWithFullDetails;
}

function PRReviews({ pr }: PRReviewsProps) {
  if (!pr.reviews || pr.reviews.length === 0) {
    return null;
  }

  return (
    <div className="px-4 py-2 border-b">
      <div className="text-xs text-muted-foreground font-medium mb-1">REVIEWS</div>
      <div className="flex flex-wrap gap-2">
        {pr.reviews.map((review) => {
          const { tone, label } = getReviewStatePresentation(review.state);
          return (
            <StatusChip key={review.id} tone={tone} size="md">
              {review.author.login}: {label}
            </StatusChip>
          );
        })}
      </div>
    </div>
  );
}

interface PRCommentsProps {
  pr: PRWithFullDetails;
}

function PRComments({ pr }: PRCommentsProps) {
  if (!pr.comments || pr.comments.length === 0) {
    return null;
  }

  return (
    <div className="divide-y">
      <div className="px-4 py-2 bg-muted sticky top-0 border-b">
        <span className="text-xs text-muted-foreground font-medium">
          COMMENTS ({pr.comments.length})
        </span>
      </div>
      {pr.comments
        .slice()
        .reverse()
        .map((comment: GitHubComment) => (
          <div key={comment.id} className="px-4 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium text-sm">{comment.author.login}</span>
              <span className="text-xs text-muted-foreground">
                {formatDateTimeShort(comment.createdAt)}
              </span>
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none text-sm text-muted-foreground overflow-hidden break-words [&_table]:text-xs [&_table]:border-collapse [&_table]:w-full [&_table]:overflow-x-auto [&_table]:block [&_th]:border [&_th]:px-1 [&_th]:py-0.5 [&_td]:border [&_td]:px-1 [&_td]:py-0.5 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-1 [&_h2]:mb-0.5 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:text-xs [&_code]:break-all">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw, rehypeSanitize]}
              >
                {comment.body}
              </ReactMarkdown>
            </div>
          </div>
        ))}
    </div>
  );
}

interface InfoTabContentProps {
  pr: PRWithFullDetails;
}

function InfoTabContent({ pr }: InfoTabContentProps) {
  return (
    <>
      <CIChecksSection checks={pr.statusCheckRollup} defaultExpanded={true} />
      <PRReviews pr={pr} />
      <PRComments pr={pr} />
    </>
  );
}

interface DiffTabContentProps {
  diffLoading: boolean;
  diff: string | null;
  diffError?: string | null;
  onRetry: () => void;
}

function DiffTabContent({ diffLoading, diff, diffError, onRetry }: DiffTabContentProps) {
  if (diffError && !diff) {
    return (
      <QueryErrorState
        title="Couldn't load pull request diff"
        error={{ message: diffError }}
        onRetry={onRetry}
        isRetrying={diffLoading}
      />
    );
  }
  if (diffLoading) {
    return <Loading size="compact" message="Loading diff…" />;
  }

  if (diff) {
    return <DiffViewer diff={diff} />;
  }

  return <EmptyState size="compact" title="No diff available" />;
}

function NoPRSelected() {
  return (
    <EmptyState icon={GitPullRequestIcon} title="No PR selected" className="h-full">
      <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
        <Kbd>j</Kbd>
        <Kbd>k</Kbd>
        <span>to navigate</span>
      </div>
    </EmptyState>
  );
}

interface TabBarProps {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}

function TabBar({ activeTab, onTabChange }: TabBarProps) {
  return (
    <div className="px-4 py-2 border-b flex items-center justify-between flex-shrink-0 bg-muted">
      <Tabs value={activeTab} onValueChange={(value) => onTabChange(value as Tab)}>
        <TabsList className="h-8">
          <TabsTrigger value="info" data-review-tab="info">
            Info
          </TabsTrigger>
          <TabsTrigger value="diff" data-review-tab="diff">
            Diff
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <Kbd>i</Kbd>
        <Kbd>d</Kbd>
      </div>
    </div>
  );
}

interface ActionButtonsProps {
  pr: PRWithFullDetails;
  approving: boolean;
  onOpenGitHub: () => void;
  onApprove: () => void;
}

function ActionButtons({ pr, approving, onOpenGitHub, onApprove }: ActionButtonsProps) {
  return (
    <div className="px-4 py-2 border-t bg-muted flex gap-2 flex-shrink-0">
      <Button variant="outline" size="sm" onClick={onOpenGitHub} className="flex-1 h-8 min-w-0">
        <span className="truncate">GitHub</span>
        <span className="ml-2 flex items-center gap-1">
          <Kbd>o</Kbd>
        </span>
      </Button>
      <Button
        size="sm"
        variant={pr.reviewDecision === 'APPROVED' ? 'secondary' : 'default'}
        onClick={onApprove}
        className="flex-1 h-8 min-w-0"
        disabled={approving || pr.reviewDecision === 'APPROVED'}
        aria-keyshortcuts="Shift+A"
      >
        <span className="truncate">{getApproveButtonText(approving, pr.reviewDecision)}</span>
        {!approving && pr.reviewDecision !== 'APPROVED' && (
          <KbdGroup className="ml-2 opacity-80" aria-hidden="true">
            <Kbd>⇧</Kbd>
            <Kbd>A</Kbd>
          </KbdGroup>
        )}
      </Button>
    </div>
  );
}

export function PRDetailPanel(props: PRDetailPanelProps) {
  const { pr } = props;
  if (!pr) {
    return <NoPRSelected />;
  }
  // Each PR opens on its Info tab.
  return <PRDetail key={`${pr.repository.nameWithOwner}#${pr.number}`} {...props} pr={pr} />;
}

function PRDetail({
  pr,
  diff,
  diffLoading,
  diffError,
  onFetchDiff,
  onOpenGitHub,
  onApprove,
  approving = false,
}: PRDetailPanelProps & { pr: PRWithFullDetails }) {
  const [activeTab, setActiveTab] = useState<Tab>('info');

  // Fetch diff when diff tab is selected
  useEffect(() => {
    if (activeTab === 'diff' && !diff && !diffLoading && !diffError) {
      onFetchDiff();
    }
  }, [activeTab, diff, diffLoading, diffError, onFetchDiff]);

  // Plain-key shortcuts yield to modified keys (⌘D bookmarks the page), text fields and menus.
  useShortcut('reviews.showDiff', () => setActiveTab('diff'));
  useShortcut('reviews.showInfo', () => setActiveTab('info'));

  return (
    <div className="h-full flex flex-col text-sm overflow-hidden">
      <PRHeader pr={pr} />
      <PRStats pr={pr} />
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
      <div className="flex-1 overflow-auto">
        {activeTab === 'info' ? (
          <InfoTabContent pr={pr} />
        ) : (
          <DiffTabContent
            diffLoading={diffLoading}
            diff={diff}
            diffError={diffError}
            onRetry={onFetchDiff}
          />
        )}
      </div>
      <ActionButtons
        pr={pr}
        approving={approving}
        onOpenGitHub={onOpenGitHub}
        onApprove={onApprove}
      />
    </div>
  );
}
