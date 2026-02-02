'use client';

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { CommandInfo } from '@/lib/claude-types';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

/**
 * Result of handling a keyboard event in the slash command palette.
 * - 'handled': Event was fully handled, caller should preventDefault
 * - 'passthrough': Event should be handled by normal input logic
 * - 'close-and-passthrough': Menu should close but event should still be processed
 */
export type SlashKeyResult = 'handled' | 'passthrough' | 'close-and-passthrough';

/** Imperative handle exposed by SlashCommandPalette */
export interface SlashCommandPaletteHandle {
  /** Handle a keyboard event. Returns how the event should be handled. */
  handleKeyDown: (key: string) => SlashKeyResult;
}

export interface SlashCommandPaletteProps {
  /** Available slash commands */
  commands: CommandInfo[];
  /** Whether the palette is open */
  isOpen: boolean;
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
  onClose,
  onSelect,
  filter,
  anchorRef,
  paletteRef,
}: SlashCommandPaletteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter commands based on the filter text (case-insensitive)
  const filteredCommands = useMemo(
    () => commands.filter((cmd) => cmd.name.toLowerCase().includes(filter.toLowerCase())),
    [commands, filter]
  );

  // Reset selection when filter changes or palette opens
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter and isOpen are intentionally used to trigger reset
  useEffect(() => {
    // Only reset to 0 if there are commands to select
    if (filteredCommands.length > 0) {
      setSelectedIndex(0);
    }
  }, [filter, isOpen, filteredCommands.length]);

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
   * Handle a keyboard event. Called by parent via paletteRef.
   * Returns the result indicating how the event should be handled.
   */
  const handleKeyDown = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: switch handles multiple key types
    (key: string): SlashKeyResult => {
      const hasMatches = filteredCommands.length > 0;

      switch (key) {
        case 'ArrowDown':
          if (hasMatches) {
            setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1));
          }
          return 'handled';

        case 'ArrowUp':
          if (hasMatches) {
            setSelectedIndex((prev) => Math.max(prev - 1, 0));
          }
          return 'handled';

        case 'Enter':
          if (hasMatches && filteredCommands[selectedIndex]) {
            onSelect(filteredCommands[selectedIndex]);
            return 'handled';
          }
          // No matches - close menu and let message be sent
          return 'close-and-passthrough';

        case 'Tab':
          if (hasMatches && filteredCommands[selectedIndex]) {
            onSelect(filteredCommands[selectedIndex]);
            return 'handled';
          }
          // No matches - let Tab work normally (focus next element)
          return 'passthrough';

        case 'Escape':
          onClose();
          return 'handled';

        default:
          return 'passthrough';
      }
    },
    [filteredCommands, selectedIndex, onSelect, onClose]
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
          <CommandEmpty>No commands found</CommandEmpty>
          <CommandGroup>
            {filteredCommands.map((command, index) => (
              <CommandItem
                key={command.name}
                value={command.name}
                onSelect={() => onSelect(command)}
                className="cursor-pointer"
                onMouseEnter={() => setSelectedIndex(index)}
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
