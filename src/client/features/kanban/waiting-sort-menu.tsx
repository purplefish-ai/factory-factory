import { SortDescendingIcon } from '@phosphor-icons/react/dist/csr/SortDescending';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { WaitingSortOrder } from './board-view';

export function WaitingSortMenu({
  value,
  onChange,
}: {
  value: WaitingSortOrder;
  onChange: (order: WaitingSortOrder) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Waiting sort order">
          <SortDescendingIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Sort by · newest first</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(order) => {
            if (order === 'latest-message' || order === 'created') {
              onChange(order);
            }
          }}
        >
          <DropdownMenuRadioItem value="latest-message">Latest message</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="created">Created</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
