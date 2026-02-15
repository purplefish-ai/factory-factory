import { useCallback, useMemo } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { CommandInfo } from '@/lib/chat-protocol';
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
 * Result of handling a keyboard event in the slash command palette.
 * - 'handled': Event was fully handled, caller should preventDefault
 * - 'passthrough': Event should be handled by normal input logic
 * - 'close-and-passthrough': Menu should close but event should still be processed
 */
export type SlashKeyResult = PaletteKeyResult;

/** Imperative handle exposed by SlashCommandPalette */
export interface SlashCommandPaletteHandle extends PaletteKeyboardHandle {}

export interface SlashCommandPaletteProps {
  /** Available slash commands */
  commands: CommandInfo[];
  /** Whether the palette is open */
  isOpen: boolean;
  /** Whether the commands are still loading */
  isLoading?: boolean;
  /** Called when the palette should close */
  onClose: () => void;
  /** Called when a command is selected */
  onSelect: (command: CommandInfo) => void;
  /** Current filter text (text after the /) */
  filter: string;
  /** Reference to the input element for click-outside detection */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Imperative handle ref for keyboard handling */
  paletteRef?: React.RefObject<SlashCommandPaletteHandle | null>;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Slash command palette component.
 *
 * Displays a floating dropdown above the chat input that shows available
 * slash commands from the Claude CLI. Supports keyboard navigation and
 * filtering by command name.
 *
 * Keyboard handling is controlled by the parent component via the paletteRef.
 * Call paletteRef.current.handleKeyDown(key) to handle keyboard events.
 */
export function SlashCommandPalette({
  commands,
  isOpen,
  isLoading = false,
  onClose,
  onSelect,
  filter,
  anchorRef,
  paletteRef,
}: SlashCommandPaletteProps) {
  // Filter commands based on the filter text (case-insensitive)
  const filteredCommands = useMemo(
    () => commands.filter((cmd) => cmd.name.toLowerCase().includes(filter.toLowerCase())),
    [commands, filter]
  );

  const handleSelectByIndex = useCallback(
    (index: number): boolean => {
      const selectedCommand = filteredCommands[index];
      if (!selectedCommand) {
        return false;
      }
      onSelect(selectedCommand);
      return true;
    },
    [filteredCommands, onSelect]
  );

  const { containerRef, itemRefs, selectedIndex, setSelectedIndex } = usePaletteKeyboardNavigation({
    isOpen,
    itemCount: filteredCommands.length,
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

  // Get the selected command name for cmdk's value-based highlighting
  const selectedCommandName = filteredCommands[selectedIndex]?.name ?? '';

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
        value={selectedCommandName}
        className="[&_[cmdk-list]]:max-h-[200px]"
      >
        <CommandList>
          <CommandEmpty>
            {isLoading ? (
              <span className="text-xs text-muted-foreground">Loading commands...</span>
            ) : (
              'No commands found'
            )}
          </CommandEmpty>
          <CommandGroup>
            {filteredCommands.map((command, index) => (
              <CommandItem
                key={command.name}
                value={command.name}
                onSelect={() => onSelect(command)}
                className="cursor-pointer"
                onMouseEnter={() => setSelectedIndex(index)}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
              >
                <div className="flex flex-col gap-0.5 w-full">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-primary">/{command.name}</span>
                    {command.argumentHint && (
                      <span className="text-xs text-muted-foreground">{command.argumentHint}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground line-clamp-1">
                    {command.description}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}
