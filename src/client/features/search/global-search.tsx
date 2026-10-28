import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { trpc } from '@/client/lib/trpc';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { SearchResult } from '@/shared/search';
import { SearchDialog } from './search-dialog';
import { getSearchResultUrl } from './search-navigation';

export function GlobalSearch() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [archivePreview, setArchivePreview] = useState<SearchResult | null>(null);
  const setSearchOpen = useCallback((value: boolean) => {
    setOpen(value);
    if (!value) {
      setQuery('');
      setDebouncedQuery('');
    }
  }, []);
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
  const select = (result: SearchResult) => {
    // Archived workspaces cannot enter the live chat route (it redirects and
    // their worktree may be gone). Keep discovery read-only and explicit.
    if (result.archived) {
      setOpen(false);
      setArchivePreview(result);
      return;
    }
    setSearchOpen(false);
    void navigate(getSearchResultUrl(result));
  };
  const modifier = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl';
  return (
    <>
      <SearchDialog
        open={open}
        onOpenChange={setSearchOpen}
        query={query}
        onQueryChange={setQuery}
        includeArchived={includeArchived}
        onIncludeArchivedChange={setIncludeArchived}
        results={search.data ?? []}
        loading={query.trim() !== debouncedQuery || search.isPending}
        error={query.trim() === debouncedQuery && search.isError}
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
            className="h-8 gap-2 px-2 text-muted-foreground"
          >
            <MagnifyingGlassIcon className="size-4" />
            <span className="hidden md:inline">Search</span>
            <kbd className="hidden rounded border px-1 text-[10px] font-normal md:inline">
              {modifier} K
            </kbd>
          </Button>
        }
      />
      <Dialog
        open={archivePreview !== null}
        onOpenChange={(value) => {
          if (!value) {
            setArchivePreview(null);
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
              setArchivePreview(null);
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
