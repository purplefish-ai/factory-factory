import { Input } from '@/components/ui/input';

export function BoardViewControls({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
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
    </div>
  );
}
