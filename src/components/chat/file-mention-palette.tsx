import { File, Folder } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import {
  type PaletteKeyboardHandle,
  type PaletteKeyResult,
  usePaletteKeyboardNavigation,
} from './palette-keyboard-navigation';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of handling a keyboard event in the file mention palette.
 * - 'handled': Event was fully handled, caller should preventDefault
 * - 'passthrough': Event should be handled by normal input logic
 * - 'close-and-passthrough': Menu should close but event should still be processed
 */
export type FileMentionKeyResult = PaletteKeyResult;

/** Imperative handle exposed by FileMentionPalette */
export interface FileMentionPaletteHandle extends PaletteKeyboardHandle {}

export interface FileMentionPaletteProps {
  /** Available file paths */
  files: string[];
  /** Whether the palette is open */
  isOpen: boolean;
  /** Whether the files are still loading */
  isLoading?: boolean;
  /** Called when the palette should close */
  onClose: () => void;
  /** Called when a file is selected */
  onSelect: (filePath: string) => void;
  /** Current filter text (text after the @) */
  filter: string;
  /** Reference to the input element for click-outside detection */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Imperative handle ref for keyboard handling */
  paletteRef?: React.RefObject<FileMentionPaletteHandle | null>;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get file icon based on file extension or path
 */
function getFileIcon(filePath: string): React.ReactNode {
  // For now, simple folder/file distinction
  // Could be enhanced with more specific icons based on file type
  if (filePath.includes('/')) {
    return <Folder className="h-3.5 w-3.5 text-muted-foreground" />;
  }

  return <File className="h-3.5 w-3.5 text-muted-foreground" />;
}

/**
 * Format file path for display: show basename prominently with path in muted text
 */
function formatFilePath(filePath: string): { basename: string; directory: string } {
  const parts = filePath.split('/');
  const basename = parts.pop() ?? filePath;
  const directory = parts.length > 0 ? `${parts.join('/')}/` : '';
  return { basename, directory };
}

// =============================================================================
// Component
// =============================================================================

/**
 * Determine whether the palette should open above or below the anchor element
 * based on available viewport space. The palette max-height is 200px plus some
 * margin, so we need roughly 230px of room.
 */
function usePlacement(
  anchorRef: React.RefObject<HTMLElement | null>,
  isOpen: boolean
): 'above' | 'below' {
  const [placement, setPlacement] = useState<'above' | 'below'>('above');

  useEffect(() => {
    if (!(isOpen && anchorRef.current)) {
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
    const paletteHeight = 230; // 200px max-height + border/margin
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;

    setPlacement(spaceAbove >= paletteHeight || spaceAbove > spaceBelow ? 'above' : 'below');
  }, [isOpen, anchorRef]);

  return placement;
}

export function FileMentionPalette({
  files,
  isOpen,
  isLoading = false,
  onClose,
  onSelect,
  filter,
  anchorRef,
  paletteRef,
}: FileMentionPaletteProps) {
  const placement = usePlacement(anchorRef, isOpen);

  const handleSelectByIndex = useCallback(
    (index: number): boolean => {
      const selectedFilePath = files[index];
      if (!selectedFilePath) {
        return false;
      }
      onSelect(selectedFilePath);
      return true;
    },
    [files, onSelect]
  );

  const { containerRef, itemRefs, selectedIndex, setSelectedIndex } = usePaletteKeyboardNavigation({
    isOpen,
    itemCount: files.length,
    resetKey: filter,
    onClose,
    onSelectByIndex: handleSelectByIndex,
    anchorRef,
    paletteRef,
  });

  // Don't render if not open
  if (!isOpen) {
    return null;
  }

  // Get the selected file path for cmdk's value-based highlighting
  const selectedFilePath = files[selectedIndex] ?? '';

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute left-0 w-full max-w-md z-50',
        placement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1',
        'rounded-md border bg-popover text-popover-foreground shadow-md'
      )}
    >
      <Command
        shouldFilter={false}
        value={selectedFilePath}
        className="[&_[cmdk-list]]:max-h-[200px]"
      >
        <CommandList>
          <CommandEmpty>
            {isLoading ? (
              <span className="text-xs text-muted-foreground">Loading files...</span>
            ) : (
              'No files found'
            )}
          </CommandEmpty>
          <CommandGroup>
            {files.map((filePath, index) => {
              const { basename, directory } = formatFilePath(filePath);
              return (
                <CommandItem
                  key={filePath}
                  value={filePath}
                  onSelect={() => onSelect(filePath)}
                  className="cursor-pointer"
                  onMouseEnter={() => setSelectedIndex(index)}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                >
                  <div className="flex items-center gap-2 w-full min-w-0">
                    {getFileIcon(filePath)}
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span className="text-sm truncate">{basename}</span>
                      {directory && (
                        <span className="text-xs text-muted-foreground truncate">{directory}</span>
                      )}
                    </div>
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
