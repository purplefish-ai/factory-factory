import { File, Folder } from 'lucide-react';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of handling a keyboard event in the file mention palette.
 * - 'handled': Event was fully handled, caller should preventDefault
 * - 'passthrough': Event should be handled by normal input logic
 * - 'close-and-passthrough': Menu should close but event should still be processed
 */
export type FileMentionKeyResult = 'handled' | 'passthrough' | 'close-and-passthrough';

/** Imperative handle exposed by FileMentionPalette */
export interface FileMentionPaletteHandle {
  /** Handle a keyboard event. Returns how the event should be handled. */
  handleKeyDown: (key: string) => FileMentionKeyResult;
}

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
 * File mention palette component.
 *
 * Displays a floating dropdown above the chat input that shows available
 * files from the workspace. Supports keyboard navigation and filtering by file name.
 *
 * Keyboard handling is controlled by the parent component via the paletteRef.
 * Call paletteRef.current.handleKeyDown(key) to handle keyboard events.
 */
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
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(selectedIndex);
  const prevFilterRef = useRef(filter);

  // Reset selection when filter changes or palette opens
  useEffect(() => {
    const filterChanged = prevFilterRef.current !== filter;
    prevFilterRef.current = filter;

    if (isOpen && filterChanged) {
      setSelectedIndex(0);
      selectedIndexRef.current = 0;
    }
  }, [isOpen, filter]);

  // Keep selectedIndex ref in sync with state
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  // Keep refs array in sync with files list length
  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, files.length);
  }, [files.length]);

  // Ensure the selected item stays visible when navigating with the keyboard
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const selectedItem = itemRefs.current[selectedIndex];
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, selectedIndex]);

  // Click outside to close
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      // Don't close if clicking inside the palette or the anchor (input)
      if (containerRef.current?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }
      onClose();
    };

    // Use mousedown to close before focus changes
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorRef]);

  /**
   * Handle arrow down key - move selection down
   */
  const handleArrowDown = useCallback(() => {
    if (files.length > 0) {
      setSelectedIndex((prev) => Math.min(prev + 1, files.length - 1));
    }
    return 'handled' as const;
  }, [files.length]);

  /**
   * Handle arrow up key - move selection up
   */
  const handleArrowUp = useCallback(() => {
    if (files.length > 0) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    }
    return 'handled' as const;
  }, [files.length]);

  /**
   * Select the currently highlighted file if available
   */
  const selectCurrentFile = useCallback(() => {
    const hasMatches = files.length > 0;
    const currentIndex = selectedIndexRef.current;
    if (hasMatches && files[currentIndex]) {
      onSelect(files[currentIndex]);
      return true;
    }
    return false;
  }, [files, onSelect]);

  /**
   * Handle Enter key - select file or close and passthrough
   */
  const handleEnter = useCallback((): FileMentionKeyResult => {
    if (selectCurrentFile()) {
      return 'handled';
    }
    // No matches - close menu and let message be sent
    return 'close-and-passthrough';
  }, [selectCurrentFile]);

  /**
   * Handle Tab key - select file or passthrough
   */
  const handleTab = useCallback((): FileMentionKeyResult => {
    if (selectCurrentFile()) {
      return 'handled';
    }
    // No matches - let Tab work normally (focus next element)
    return 'passthrough';
  }, [selectCurrentFile]);

  /**
   * Handle Escape key - close the palette
   */
  const handleEscape = useCallback(() => {
    onClose();
    return 'handled' as const;
  }, [onClose]);

  /**
   * Map of key names to their handler functions
   */
  const keyHandlers = useMemo(
    () => ({
      ArrowDown: handleArrowDown,
      ArrowUp: handleArrowUp,
      Enter: handleEnter,
      Tab: handleTab,
      Escape: handleEscape,
    }),
    [handleArrowDown, handleArrowUp, handleEnter, handleTab, handleEscape]
  );

  /**
   * Handle a keyboard event. Called by parent via paletteRef.
   * Returns the result indicating how the event should be handled.
   */
  const handleKeyDown = useCallback(
    (key: string): FileMentionKeyResult => {
      const handler = keyHandlers[key as keyof typeof keyHandlers];
      return handler ? handler() : 'passthrough';
    },
    [keyHandlers]
  );

  // Expose handleKeyDown via imperative handle
  useImperativeHandle(
    paletteRef,
    () => ({
      handleKeyDown,
    }),
    [handleKeyDown]
  );

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
        'absolute bottom-full left-0 mb-1 w-full max-w-md z-50',
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
