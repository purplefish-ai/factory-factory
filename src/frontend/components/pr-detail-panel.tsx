'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { GitHubComment, PRWithFullDetails } from '@/shared/github-types';
import { CIChecksSection, CIStatusBadge, ReviewDecisionBadge } from './pr-status-badges';

interface PRDetailPanelProps {
  pr: PRWithFullDetails | null;
  diff: string | null;
  diffLoading: boolean;
  onFetchDiff: () => void;
  onOpenGitHub: () => void;
  onApprove: () => void;
  approving?: boolean;
}

type Tab = 'info' | 'diff';

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface DiffFile {
  name: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffLine {
  type: 'add' | 'del' | 'context';
  content: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: diff parsing requires multiple conditions
function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split('\n');
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) {
        files.push(currentFile);
      }
      const match = line.match(/b\/(.+)$/);
      currentFile = {
        name: match?.[1] || 'unknown',
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      currentHunk = null;
    } else if (line.startsWith('@@') && currentFile) {
      currentHunk = { header: line, lines: [] };
      currentFile.hunks.push(currentHunk);
    } else if (currentHunk && currentFile) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1) });
        currentFile.additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({ type: 'del', content: line.slice(1) });
        currentFile.deletions++;
      } else if (!line.startsWith('\\')) {
        currentHunk.lines.push({
          type: 'context',
          content: line.slice(1) || '',
        });
      }
    }
  }

  if (currentFile) {
    files.push(currentFile);
  }
  return files;
}

function DiffViewer({ diff }: { diff: string }) {
  const files = parseDiff(diff);

  return (
    <div className="divide-y">
      {files.map((file) => (
        <div key={file.name} className="text-xs">
          <div className="px-3 py-1.5 bg-muted/50 font-mono sticky top-0 flex items-center gap-2">
            <span className="font-medium truncate">{file.name}</span>
            {file.additions > 0 && <span className="text-green-600">+{file.additions}</span>}
            {file.deletions > 0 && <span className="text-red-600">-{file.deletions}</span>}
          </div>
          <div className="font-mono text-xs leading-tight overflow-x-auto">
            {file.hunks.map((hunk) => (
              <div key={hunk.header}>
                <div className="px-3 py-1 bg-blue-500/10 text-blue-600 text-xs">{hunk.header}</div>
                {/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: diff line rendering */}
                {hunk.lines.map((line, lineIdx) => (
                  <div
                    key={`${hunk.header}-${lineIdx}`}
                    className={`px-3 whitespace-pre ${
                      line.type === 'add'
                        ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                        : line.type === 'del'
                          ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                          : ''
                    }`}
                  >
                    <span className="select-none opacity-50 mr-2">
                      {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                    </span>
                    {line.content}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: complex UI component with multiple states
export function PRDetailPanel({
  pr,
  diff,
  diffLoading,
  onFetchDiff,
  onOpenGitHub,
  onApprove,
  approving = false,
}: PRDetailPanelProps) {
  const [activeTab, setActiveTab] = useState<Tab>('info');

  // Create a stable key for the current PR to detect changes
  const prKey = pr ? `${pr.repository.nameWithOwner}#${pr.number}` : null;

  // Reset tab when PR changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset when prKey changes
  useEffect(() => {
    setActiveTab('info');
  }, [prKey]);

  // Fetch diff when diff tab is selected
  useEffect(() => {
    if (activeTab === 'diff' && pr && !diff && !diffLoading) {
      onFetchDiff();
    }
  }, [activeTab, pr, diff, diffLoading, onFetchDiff]);

  // Handle keyboard shortcuts for tabs
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === 'd' && pr) {
        e.preventDefault();
        setActiveTab('diff');
      }
      if (e.key === 'i' && pr) {
        e.preventDefault();
        setActiveTab('info');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pr]);

  if (!pr) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        <div className="text-center">
          <p>No PR selected</p>
          <div className="mt-2 flex items-center justify-center gap-1">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd>
            <span className="text-xs text-muted-foreground">to navigate</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col text-sm overflow-hidden">
      {/* Header */}
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

      {/* Stats row */}
      <div className="px-4 py-2 border-b flex items-center gap-2 text-xs flex-shrink-0 flex-wrap">
        <span>
          <strong>{pr.changedFiles}</strong> files
        </span>
        <span className="text-green-600">
          <strong>+{pr.additions}</strong>
        </span>
        <span className="text-red-600">
          <strong>-{pr.deletions}</strong>
        </span>
        <span className="flex-1 min-w-0" />
        <CIStatusBadge checks={pr.statusCheckRollup} />
        <ReviewDecisionBadge decision={pr.reviewDecision} />
        <Badge
          variant="outline"
          className={`text-xs px-1.5 py-0 flex-shrink-0 ${
            pr.mergeStateStatus === 'CLEAN'
              ? 'bg-green-500/20 text-green-600 border-green-500/30'
              : pr.mergeStateStatus === 'BLOCKED' || pr.mergeStateStatus === 'DIRTY'
                ? 'bg-red-500/20 text-red-600 border-red-500/30'
                : ''
          }`}
        >
          {pr.mergeStateStatus}
        </Badge>
      </div>

      {/* Tab bar */}
      <div className="px-4 py-2 border-b flex items-center justify-between flex-shrink-0 bg-muted/20">
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as Tab)}>
          <TabsList className="h-8">
            <TabsTrigger value="info">Info</TabsTrigger>
            <TabsTrigger value="diff">Diff</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>i</Kbd>
          <Kbd>d</Kbd>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'info' ? (
          <>
            {/* CI Checks */}
            <CIChecksSection checks={pr.statusCheckRollup} defaultExpanded={true} />

            {/* Reviews */}
            {pr.reviews && pr.reviews.length > 0 && (
              <div className="px-4 py-2 border-b">
                <div className="text-xs text-muted-foreground font-medium mb-1">REVIEWS</div>
                <div className="flex flex-wrap gap-2">
                  {pr.reviews.map((review) => (
                    <span
                      key={review.id}
                      className={`text-xs px-1.5 py-0.5 rounded ${
                        review.state === 'APPROVED'
                          ? 'bg-green-500/20 text-green-600'
                          : review.state === 'CHANGES_REQUESTED'
                            ? 'bg-red-500/20 text-red-600'
                            : 'bg-muted'
                      }`}
                    >
                      {review.author.login}: {review.state}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Comments */}
            {pr.comments && pr.comments.length > 0 && (
              <div className="divide-y">
                <div className="px-4 py-2 bg-muted/30 sticky top-0">
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
                          {formatDate(comment.createdAt)}
                        </span>
                      </div>
                      <div className="prose prose-sm dark:prose-invert max-w-none text-sm text-muted-foreground overflow-hidden break-words [&_table]:text-xs [&_table]:border-collapse [&_table]:w-full [&_table]:overflow-x-auto [&_table]:block [&_th]:border [&_th]:px-1 [&_th]:py-0.5 [&_td]:border [&_td]:px-1 [&_td]:py-0.5 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-1 [&_h2]:mb-0.5 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_code]:text-xs [&_code]:break-all">
                        <ReactMarkdown>{comment.body}</ReactMarkdown>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </>
        ) : diffLoading ? (
          <div className="p-4 text-center text-muted-foreground text-xs">Loading diff...</div>
        ) : diff ? (
          <DiffViewer diff={diff} />
        ) : (
          <div className="p-4 text-center text-muted-foreground text-xs">No diff available</div>
        )}
      </div>

      {/* Action buttons */}
      <div className="px-4 py-2 border-t bg-muted/30 flex gap-2 flex-shrink-0">
        <Button variant="outline" size="sm" onClick={onOpenGitHub} className="flex-1 h-8 min-w-0">
          <span className="truncate">GitHub</span>
          <span className="ml-2 flex items-center gap-1">
            <Kbd>o</Kbd>
          </span>
        </Button>
        <Button
          size="sm"
          onClick={onApprove}
          className={`flex-1 h-8 min-w-0 ${
            pr.reviewDecision === 'APPROVED'
              ? 'bg-green-800 hover:bg-green-800 cursor-default'
              : 'bg-green-600 hover:bg-green-700'
          }`}
          disabled={approving || pr.reviewDecision === 'APPROVED'}
        >
          <span className="truncate">
            {approving ? 'Approving...' : pr.reviewDecision === 'APPROVED' ? 'Approved' : 'Approve'}
          </span>
          {!approving && pr.reviewDecision !== 'APPROVED' && (
            <span className="ml-2 flex items-center gap-1 opacity-80">
              <Kbd>a</Kbd>
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}
