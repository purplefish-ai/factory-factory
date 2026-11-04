import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { type ComponentProps, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ShortcutCommand } from '@/client/features/shortcuts';
import type { ShortcutId } from '@/client/lib/keyboard-shortcuts';
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
import { filterCommands, getCommandValue, SearchCommands } from './search-commands';
import { SearchResults, type SearchResultsProps } from './search-results';

export interface SearchDialogProps extends SearchResultsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger?: ReactNode;
  onQueryChange: (query: string) => void;
  includeArchived: boolean;
  onIncludeArchivedChange: (include: boolean) => void;
  /** Registry commands ("Go to", "Actions") listed below local results. */
  commands?: readonly ShortcutCommand[];
  onSelectCommand?: (id: ShortcutId) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
}

const noCommands: readonly ShortcutCommand[] = [];

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
  commands = noCommands,
  onSelectCommand,
  onCloseAutoFocus,
}: SearchDialogProps) {
  const [selected, setSelected] = useState('');
  const previousLocalReady = useRef(!(loading || error));
  const matchingCommands = useMemo(
    () => (onSelectCommand ? filterCommands(commands, query) : []),
    [commands, onSelectCommand, query]
  );
  useEffect(() => {
    const recovered = !(previousLocalReady.current || loading || error);
    previousLocalReady.current = !(loading || error);
    // Keep commands available even when metadata cannot load.
    if (!open) {
      setSelected('');
      return;
    }
    const available =
      loading || error ? [] : results.map((result) => `${result.kind}:${result.id}`);
    available.push(...matchingCommands.map((command) => getCommandValue(command.id)));
    if (onSearchGitHub) {
      available.push('search-github-issues');
    }
    if (!githubIssues?.loading) {
      available.push(
        ...(githubIssues?.results ?? []).map((result) => `${result.kind}:${result.id}`)
      );
    }
    setSelected((current) =>
      !recovered && available.includes(current) ? current : (available[0] ?? '')
    );
  }, [
    results,
    matchingCommands,
    githubIssues?.results,
    githubIssues?.loading,
    loading,
    error,
    open,
    onSearchGitHub,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={onCloseAutoFocus}
        className="top-[calc(var(--overlay-titlebar-bottom,0px)+1rem)] max-h-[calc(100dvh-2rem)] max-w-xl translate-y-0 gap-0 overflow-hidden rounded-xl p-0 shadow-2xl sm:top-[max(calc(var(--overlay-titlebar-bottom,0px)+1rem),min(18vh,8rem))]"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">
          Find projects, workspaces, chats, pull requests, and GitHub issues, or run a command.
          Select an issue to start a workspace.
        </DialogDescription>
        <Command
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          loop
          // cmdk's vim bindings consume Ctrl+K, which must reach the global toggle.
          vimBindings={false}
          className="**:data-[slot=command-input-wrapper]:h-14"
        >
          <div className="relative">
            <CommandInput
              value={query}
              onValueChange={onQueryChange}
              maxLength={200}
              placeholder="Search names, branches, PRs, issues, or commands…"
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
              hasCommands={matchingCommands.length > 0}
              commandGroups={
                onSelectCommand && (
                  <SearchCommands commands={matchingCommands} onSelect={onSelectCommand} />
                )
              }
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
