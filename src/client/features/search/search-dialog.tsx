import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Command, CommandInput, CommandList } from '@/components/ui/command';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { SearchResults, type SearchResultsProps } from './search-results';

export interface SearchDialogProps extends SearchResultsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
  onQueryChange: (query: string) => void;
  includeArchived: boolean;
  onIncludeArchivedChange: (include: boolean) => void;
}

export function SearchDialog({
  open,
  onOpenChange,
  trigger,
  query,
  onQueryChange,
  includeArchived,
  onIncludeArchivedChange,
  results,
  githubIssues,
  onSearchGitHub,
  loading,
  error,
  onRetry,
  onSelect,
}: SearchDialogProps) {
  const [selected, setSelected] = useState('');
  useEffect(() => {
    // Wait for local matches before automatically selecting a lower GitHub row.
    if (!open || loading || error) {
      setSelected('');
      return;
    }
    const available = [
      ...results,
      ...(!githubIssues?.loading ? (githubIssues?.results ?? []) : []),
    ].map((result) => `${result.kind}:${result.id}`);
    if (onSearchGitHub) {
      available.push('search-github-issues');
    }
    setSelected((current) => (available.includes(current) ? current : (available[0] ?? '')));
  }, [results, githubIssues?.results, githubIssues?.loading, loading, error, open, onSearchGitHub]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        showCloseButton={false}
        className="top-4 max-h-[calc(100dvh-2rem)] max-w-xl translate-y-0 gap-0 overflow-hidden rounded-xl p-0 shadow-2xl sm:top-[min(18vh,8rem)]"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Find projects, workspaces, conversations, pull requests, and GitHub issues. Select an
          issue to start a workspace.
        </DialogDescription>
        <Command
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          loop
          className="**:data-[slot=command-input-wrapper]:h-14"
        >
          <div className="relative">
            <CommandInput
              value={query}
              onValueChange={onQueryChange}
              maxLength={200}
              placeholder="Search names, branches, PRs, or issues…"
              aria-label="Search metadata"
              className="h-14 pr-10 text-base sm:text-sm"
            />
          </div>
          <CommandList
            aria-label="Search results"
            aria-busy={loading}
            className="max-h-[min(24rem,55dvh)] min-h-36 scroll-py-2 p-2"
          >
            <SearchResults
              query={query}
              results={results}
              githubIssues={githubIssues}
              onSearchGitHub={onSearchGitHub}
              loading={loading}
              error={error}
              onRetry={onRetry}
              onSelect={onSelect}
            />
          </CommandList>
        </Command>
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close search"
            className="absolute right-2 top-2.5 size-8 text-muted-foreground"
          >
            <XIcon className="size-4" />
          </Button>
        </DialogClose>
        <div className="flex items-center justify-between border-t px-3 py-2">
          <button
            type="button"
            aria-pressed={includeArchived}
            onClick={() => onIncludeArchivedChange(!includeArchived)}
            className="flex min-h-8 items-center gap-1.5 rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-pressed:text-foreground"
          >
            <ArchiveIcon className="size-3.5" />
            Include archived
            {includeArchived && <span className="size-1.5 rounded-full bg-primary" />}
          </button>
          <span
            className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex"
            aria-hidden="true"
          >
            <span>↑ ↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
