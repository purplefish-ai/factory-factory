import { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive';
import type { Ref } from 'react';
import { Button } from '@/components/ui/button';

export interface BoardSelectionBarProps {
  count: number;
  /** A selection archive is in flight. */
  isArchiving: boolean;
  onArchive: () => void;
  onCancel: () => void;
  archiveRef?: Ref<HTMLButtonElement>;
  cancelRef?: Ref<HTMLButtonElement>;
}

/** The selection mode's actions, under the board: "N selected · Archive · Cancel". */
export function BoardSelectionBar({
  count,
  isArchiving,
  onArchive,
  onCancel,
  archiveRef,
  cancelRef,
}: BoardSelectionBarProps) {
  return (
    <section
      aria-label="Workspace selection"
      className="sticky bottom-0 z-20 mx-auto flex w-full max-w-[1800px] shrink-0 flex-wrap items-center gap-2 rounded-lg border bg-background/95 px-3 py-2 shadow-sm backdrop-blur"
    >
      <p aria-live="polite" className="min-w-0 flex-1 text-sm font-medium">
        {isArchiving ? 'Archiving…' : `${count} selected`}
        <span className="ml-2 hidden text-xs font-normal text-muted-foreground sm:inline">
          Shift-click selects a range
        </span>
      </p>
      <Button
        ref={archiveRef}
        variant="destructive"
        size="sm"
        disabled={count === 0 || isArchiving}
        pending={isArchiving}
        onClick={onArchive}
      >
        <ArchiveIcon />
        Archive
      </Button>
      <Button ref={cancelRef} variant="outline" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </section>
  );
}
