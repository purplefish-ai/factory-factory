import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { lazy, Suspense, useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ErrorBoundary } from '@/client/error-boundary';
import { runShortcutCommand, useShortcut, useShortcutCommands } from '@/client/features/shortcuts';
import { useDebouncedValue } from '@/client/hooks/use-debounced-value';
import { normalizeGitHubIssue } from '@/client/lib/issue-normalization';
import {
  formatShortcut,
  getAriaKeyShortcuts,
  type ShortcutId,
} from '@/client/lib/keyboard-shortcuts';
import { QUERY_RETRY } from '@/client/lib/query-options';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
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

function searchTrigger() {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Search"
      aria-keyshortcuts={getAriaKeyShortcuts('app.search')}
      className="px-2 text-muted-foreground"
    >
      <MagnifyingGlassIcon />
      <span className="hidden @[72rem]/header:inline">Search</span>
      <kbd className="hidden rounded border px-1 text-2xs font-normal @[72rem]/header:inline">
        {formatShortcut('app.search')}
      </kbd>
    </Button>
  );
}

export function GlobalSearch() {
  const navigate = useNavigate();
  const [selectedIssue, setSelectedIssue] = useState<Extract<
    SearchResult,
    { kind: 'github_issue' }
  > | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
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
        setSubmittedIssueQuery('');
      }
    },
    [selectedIssue]
  );
  // A closed dialog drops its query at once, so reopening never searches the old one.
  const debouncedQuery = useDebouncedValue(query.trim(), 150, { immediate: !open });
  useShortcut('app.search', () => setSearchOpen(!open));
  const commands = useShortcutCommands();
  // A command moves focus itself (the composer, another page or dialog), so the
  // closing dialog must not return focus to the search button.
  const pendingCommandRef = useRef<ShortcutId | null>(null);
  const runCommand = (id: ShortcutId) => {
    pendingCommandRef.current = id;
    setSearchOpen(false);
  };
  const search = trpc.search.metadata.useQuery(
    { query: debouncedQuery, includeArchived },
    {
      enabled: open,
      staleTime: 10_000,
    }
  );
  const querySettled = query.trim() === debouncedQuery;
  const issueQuery = requestedIssueQuery(debouncedQuery, submittedIssueQuery);
  const issuesEnabled = open && querySettled && Boolean(issueQuery);
  const issues = trpc.search.githubIssues.useQuery(
    { query: issueQuery },
    { enabled: issuesEnabled, staleTime: 60_000, retry: QUERY_RETRY.costlyRead }
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
        commands={commands}
        onSelectCommand={runCommand}
        onCloseAutoFocus={(event) => {
          const command = pendingCommandRef.current;
          if (command) {
            pendingCommandRef.current = null;
            event.preventDefault();
            runShortcutCommand(command);
          }
        }}
        trigger={searchTrigger()}
      />
      {selectedIssue && (
        <ErrorBoundary
          key={selectedIssue.id}
          fallback={
            <Dialog open onOpenChange={() => setSelectedIssue(null)}>
              <DialogContent>
                <DialogTitle>Start issue</DialogTitle>
                <DialogDescription role="alert">
                  Couldn't load issue launch options. Reload the app to try again.
                </DialogDescription>
                <Button onClick={() => window.location.reload()}>Reload</Button>
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
                  <DialogTitle>Start issue</DialogTitle>
                  <DialogDescription className="flex items-center gap-2">
                    <Spinner className="size-4" aria-hidden="true" />
                    Loading issue launch options…
                  </DialogDescription>
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
              ? 'chat belongs to an archived workspace or project'
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
