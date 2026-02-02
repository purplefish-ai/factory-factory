'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Reference to the input element for positioning */
  anchorRef: React.RefObject<HTMLElement | null>;
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
 */
export function SlashCommandPalette({
  commands,
  isOpen,
  onClose,
  onSelect,
  filter,
  // anchorRef is available for future positioning enhancements
  anchorRef: _anchorRef,
}: SlashCommandPaletteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter commands based on the filter text (case-insensitive)
  const filteredCommands = commands.filter((cmd) =>
    cmd.name.toLowerCase().includes(filter.toLowerCase())
  );

  // Reset selection when filter changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter is intentionally used to trigger reset
  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!isOpen) {
        return;
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          event.preventDefault();
          if (filteredCommands[selectedIndex]) {
            onSelect(filteredCommands[selectedIndex]);
          }
          break;
        case 'Escape':
          event.preventDefault();
          onClose();
          break;
        case 'Tab':
          // Tab also selects the current command
          event.preventDefault();
          if (filteredCommands[selectedIndex]) {
            onSelect(filteredCommands[selectedIndex]);
          }
          break;
      }
    },
    [isOpen, filteredCommands, selectedIndex, onSelect, onClose]
  );

  // Attach keyboard listener to window
  useEffect(() => {
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
    return undefined;
  }, [isOpen, handleKeyDown]);

  // Don't render if not open
  if (!isOpen) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute bottom-full left-0 mb-1 w-full max-w-md z-50',
        'rounded-md border bg-popover text-popover-foreground shadow-md'
      )}
    >
      <Command className="[&_[cmdk-list]]:max-h-[200px]">
        <CommandList>
          <CommandEmpty>No commands found</CommandEmpty>
          <CommandGroup>
            {filteredCommands.map((command, index) => (
              <CommandItem
                key={command.name}
                value={command.name}
                onSelect={() => onSelect(command)}
                className={cn(
                  'cursor-pointer',
                  index === selectedIndex && 'bg-accent text-accent-foreground'
                )}
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
