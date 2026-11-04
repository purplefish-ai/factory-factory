import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import type { BoardSort } from './board-view';

export function BoardViewControls({
  search,
  onSearchChange,
  sort,
  onSortChange,
  selectedCount,
  isArchiving,
  onArchive,
  onClear,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  sort: BoardSort;
  onSortChange: (value: BoardSort) => void;
  selectedCount: number;
  isArchiving: boolean;
  onArchive: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 items-center shrink-0">
      <Input
        className="w-full sm:w-64 h-8"
        aria-label="Filter board"
        placeholder="Filter issues and workspaces…"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      <label className="flex gap-2 text-xs items-center">
        Sort
        <select
          className="h-8 rounded-md border bg-background px-2 max-w-full"
          aria-label="Sort workspaces"
          value={sort}
          onChange={(event) => {
            const value = event.target.value;
            if (
              value === 'default' ||
              value === 'newest' ||
              value === 'oldest' ||
              value === 'name'
            ) {
              onSortChange(value);
            }
          }}
        >
          <option value="default">Waiting longest first</option>
          <option value="newest">Newest created</option>
          <option value="oldest">Oldest created</option>
          <option value="name">Name</option>
        </select>
      </label>
      {selectedCount > 0 && (
        <>
          <span className="text-xs" role="status">
            {selectedCount} selected
          </span>
          <Button size="sm" variant="outline" disabled={isArchiving} onClick={onArchive}>
            {isArchiving && <Spinner className="h-4 w-4" aria-hidden="true" />}Archive selected
          </Button>
          <Button size="sm" variant="ghost" disabled={isArchiving} onClick={onClear}>
            Clear selection
          </Button>
        </>
      )}
    </div>
  );
}
