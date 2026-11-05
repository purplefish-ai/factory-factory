import { HeaderLeftStartSlot, HeaderLeftExtraSlot } from '@/client/components/app-header-context';
import { Input } from '@/components/ui/input';
import { useIsMobile } from '@/hooks/use-mobile';

export function BoardViewControls({
  search,
  onSearchChange,
}: {
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const isMobile = useIsMobile();
  const filter = (
    <div className={isMobile ? 'min-w-0 flex-1' : 'ml-2 min-w-0 w-64 shrink'}>
      <Input
        className="w-full min-w-0 h-8"
        aria-label="Filter board"
        placeholder={isMobile ? 'Filter board…' : 'Filter issues and workspaces…'}
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
    </div>
  );
  return isMobile ? (
    <HeaderLeftExtraSlot>{filter}</HeaderLeftExtraSlot>
  ) : (
    <HeaderLeftStartSlot>{filter}</HeaderLeftStartSlot>
  );
}
