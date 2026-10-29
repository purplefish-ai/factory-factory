import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ErrorBoundary } from '@/client/error-boundary';
import { normalizeGitHubIssue } from '@/client/lib/issue-normalization';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { SearchResult } from '@/shared/search';
import { SearchDialog } from './search-dialog';
import { getSearchResultUrl } from './search-navigation';

const IssueLaunchSheet = lazy(() =>
  import('@/client/features/kanban').then((module) => ({ default: module.IssueLaunchSheet }))
);
const emptyResults: SearchResult[] = [];

function requestedIssueQuery(query: string, submittedQuery: string): string {
  return /^#?\d+$/.test(query) || submittedQuery === query ? query : '';
}

export function GlobalSearch() {
  const navigate = useNavigate();
  const [selectedIssue, setSelectedIssue] = useState<Extract<
    SearchResult,
    { kind: 'github_issue' }
  > | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [submittedIssueQuery, setSubmittedIssueQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [archivePreview, setArchivePreview] = useState<SearchResult | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const setSearchOpen = useCallback(
    (value: boolean) => {
      if (value && selectedIssue) {
        return;
      }
      setOpen(value);
      if (value) {
        setArchiveOpen(false);
      }
      if (!value) {
        setQuery('');
        setDebouncedQuery('');
        setSubmittedIssueQuery('');
      }
    },
    [selectedIssue]
  );
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 150);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'k' &&
        !event.altKey &&
        !event.shiftKey &&
        !event.repeat &&
        !event.isComposing &&
        !event.defaultPrevented
      ) {
        event.preventDefault();
        setSearchOpen(!open);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, setSearchOpen]);
  const search = trpc.search.metadata.useQuery(
    { query: debouncedQuery, includeArchived },
    {
      enabled: open,
      staleTime: 10_000,
      retry: false,
      refetchOnWindowFocus: false,
    }
  );
  const querySettled = query.trim() === debouncedQuery;
  const issueQuery = requestedIssueQuery(debouncedQuery, submittedIssueQuery);
  const issuesEnabled = open && querySettled && Boolean(issueQuery);
  const issues = trpc.search.githubIssues.useQuery(
    { query: issueQuery },
    { enabled: issuesEnabled, staleTime: 60_000, retry: false, refetchOnWindowFocus: false }
  );
  const searchGitHub = useCallback(() => setSubmittedIssueQuery(debouncedQuery), [debouncedQuery]);
  const select = (result: SearchResult) => {
    if (result.kind === 'github_issue') {
      setSearchOpen(false);
      setSelectedIssue(result);
      return;
    }
    // Archived workspaces cannot enter the live chat route (it redirects and
    // their worktree may be gone). Keep discovery read-only and explicit.
    if (result.archived) {
      setOpen(false);
      setArchivePreview(result);
      setArchiveOpen(true);
      return;
    }
    setSearchOpen(false);
    setArchiveOpen(false);
    void navigate(getSearchResultUrl(result));
  };
  const modifier = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl';
  return (
    <>
      <SearchDialog
        open={open}
        onOpenChange={setSearchOpen}
        query={query}
        onQueryChange={(value) => {
          setQuery(value);
          setSubmittedIssueQuery('');
        }}
        includeArchived={includeArchived}
        onIncludeArchivedChange={setIncludeArchived}
        results={search.data ?? emptyResults}
        onSearchGitHub={
          open && querySettled && debouncedQuery && !issueQuery ? searchGitHub : undefined
        }
        githubIssues={
          issuesEnabled
            ? {
                results: querySettled ? (issues.data?.results ?? emptyResults) : emptyResults,
                loading: !querySettled || issues.isPending || issues.isFetching,
                error: issues.isError || Boolean(issues.data?.errors.length),
                onRetry: () => {
                  void issues.refetch();
                },
              }
            : undefined
        }
        loading={query.trim() !== debouncedQuery || search.isPending || search.isFetching}
        error={query.trim() === debouncedQuery && search.isError && !search.isFetching}
        onRetry={() => {
          void search.refetch();
        }}
        onSelect={select}
        trigger={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Search"
            aria-keyshortcuts="Meta+K Control+K"
            className="h-8 shrink-0 gap-2 px-2 text-muted-foreground"
          >
            <MagnifyingGlassIcon className="size-4" />
            <span className="hidden @[72rem]/header:inline">Search</span>
            <kbd className="hidden rounded border px-1 text-[10px] font-normal @[72rem]/header:inline">
              {modifier} K
            </kbd>
          </Button>
        }
      />
      {selectedIssue && (
        <ErrorBoundary
          key={selectedIssue.id}
          fallback={
            <Dialog open onOpenChange={() => setSelectedIssue(null)}>
              <DialogContent>
                <DialogTitle>Start Issue</DialogTitle>
                <DialogDescription role="alert">
                  Unable to load issue launch options. Reload the app to try again.
                </DialogDescription>
                <Button variant="outline" onClick={() => setSelectedIssue(null)}>
                  Close
                </Button>
              </DialogContent>
            </Dialog>
          }
        >
          <Suspense
            fallback={
              <Dialog open onOpenChange={() => setSelectedIssue(null)}>
                <DialogContent>
                  <DialogTitle>Start Issue</DialogTitle>
                  <DialogDescription>Loading issue launch options…</DialogDescription>
                </DialogContent>
              </Dialog>
            }
          >
            <IssueLaunchSheet
              key={selectedIssue.id}
              issue={normalizeGitHubIssue(selectedIssue.githubIssue)}
              projectId={selectedIssue.projectId}
              open
              onOpenChange={(value) => {
                if (!value) {
                  setSelectedIssue(null);
                }
              }}
            />
          </Suspense>
        </ErrorBoundary>
      )}
      <Dialog
        open={archiveOpen}
        onOpenChange={(value) => {
          if (!value) {
            setArchiveOpen(false);
            setSearchOpen(false);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>{archivePreview?.title}</DialogTitle>
          <DialogDescription>{archivePreview?.subtitle}</DialogDescription>
          <p className="text-sm text-muted-foreground">
            This{' '}
            {archivePreview?.kind === 'session'
              ? 'conversation belongs to an archived workspace or project'
              : `${archivePreview?.kind} is archived`}
            . Search shows its saved metadata; live chat is unavailable.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setArchiveOpen(false);
              setOpen(true);
            }}
          >
            Back to search
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
