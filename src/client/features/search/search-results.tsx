import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import { ArrowElbowDownLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowElbowDownLeft';
import { ChatCircleIcon } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple';
import { StackSimpleIcon } from '@phosphor-icons/react/dist/csr/StackSimple';
import { Button } from '@/components/ui/button';
import { CommandGroup, CommandItem } from '@/components/ui/command';
import type { SearchResult } from '@/shared/search';

const resultKinds = {
  project: { label: 'Project', Icon: FolderSimpleIcon },
  workspace: { label: 'Workspace', Icon: StackSimpleIcon },
  session: { label: 'Conversation', Icon: ChatCircleIcon },
};

export interface SearchResultsProps {
  query: string;
  results: SearchResult[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onSelect: (result: SearchResult) => void;
}

function MatchedText({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return <>{text}</>;
  }
  const expression = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  let offset = 0;
  return text.split(new RegExp(`(${expression})`, 'gi')).map((part) => {
    const key = `${offset}:${part}`;
    offset += part.length;
    return words.some((word) => word.toLowerCase() === part.toLowerCase()) ? (
      <mark key={key} className="bg-transparent font-semibold text-foreground">
        {part}
      </mark>
    ) : (
      <span key={key}>{part}</span>
    );
  });
}

function ResultRow({
  result,
  query,
  onSelect,
}: Pick<SearchResultsProps, 'query' | 'onSelect'> & { result: SearchResult }) {
  const { Icon, label } = resultKinds[result.kind];
  return (
    <CommandItem
      value={`${result.kind}:${result.id}`}
      onSelect={() => onSelect(result)}
      className="group min-h-16 cursor-pointer gap-3 rounded-lg px-3 py-2.5"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background/60 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          <MatchedText text={result.title} query={query} />
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          <MatchedText text={result.subtitle} query={query} />
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {result.archived ? (
          <span className="flex items-center gap-1">
            <ArchiveIcon className="size-3" />
            Archived
          </span>
        ) : (
          <span className="sr-only sm:not-sr-only">{label}</span>
        )}
      </span>
      <ArrowElbowDownLeftIcon className="hidden size-3.5 text-muted-foreground group-data-[selected=true]:sm:block" />
    </CommandItem>
  );
}

export function SearchResults({
  query,
  results,
  loading,
  error,
  onRetry,
  onSelect,
}: SearchResultsProps) {
  if (error) {
    return (
      <div
        role="alert"
        className="flex min-h-32 flex-col items-center justify-center gap-2 text-sm"
      >
        <p className="text-muted-foreground">Couldn’t search right now.</p>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (loading) {
    return (
      <div
        role="status"
        className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
        Searching…
      </div>
    );
  }
  if (!results.length) {
    return (
      <div
        role="status"
        className="flex min-h-32 flex-col items-center justify-center gap-1 text-center text-sm"
      >
        <p>{query.trim() ? 'No results found' : 'Nothing here yet'}</p>
        <p className="text-xs text-muted-foreground">
          {query.trim()
            ? 'Try a name, branch, issue, or PR number.'
            : 'Your projects and workspaces will appear here.'}
        </p>
      </div>
    );
  }
  return (
    <CommandGroup heading={query.trim() ? 'Results' : 'Recent'} className="p-0">
      {results.map((result) => (
        <ResultRow
          key={`${result.kind}:${result.id}`}
          result={result}
          query={query}
          onSelect={onSelect}
        />
      ))}
    </CommandGroup>
  );
}
