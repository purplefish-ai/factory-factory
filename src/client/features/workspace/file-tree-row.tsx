import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { memo, type ReactNode } from 'react';

export const FILE_TREE_ROW_HEIGHT = 28;

interface FileTreeRowProps {
  depth?: number;
  expanded?: boolean;
  icon: ReactNode;
  label: ReactNode;
  children?: ReactNode;
  title?: string;
  onClick: () => void;
}

/** Shared geometry for Files and Changes, including the disclosure column. */
export const FileTreeRow = memo(function FileTreeRow({
  depth = 0,
  expanded,
  icon,
  label,
  children,
  title,
  onClick,
}: FileTreeRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      title={title}
      className="w-full flex items-center gap-1 px-2 text-sm text-left font-normal hover:bg-muted/50 rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      style={{ height: FILE_TREE_ROW_HEIGHT, paddingLeft: depth * 12 + 8 }}
    >
      {expanded === undefined ? (
        <span className="size-4 shrink-0" />
      ) : expanded ? (
        <CaretDownIcon className="size-4 text-muted-foreground shrink-0" />
      ) : (
        <CaretRightIcon className="size-4 text-muted-foreground shrink-0" />
      )}
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {children}
    </button>
  );
});
