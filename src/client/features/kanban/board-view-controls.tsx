import { HeaderLeftStartSlot } from '@/client/components/app-header-context';
import { Input } from '@/components/ui/input';

export function BoardViewControls({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
}) {
  return (
    <HeaderLeftStartSlot>
      <div className="ml-2 min-w-0 w-64 shrink">
        <Input
          className="w-full min-w-0 h-8"
          aria-label="Filter board"
          placeholder="Filter issues and workspaces…"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
    </HeaderLeftStartSlot>
  );
}
