import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CommandInfo } from '@/lib/claude-types';

import type { SlashCommandPaletteHandle, SlashKeyResult } from '../../slash-command-palette';

interface UseSlashCommandsOptions {
  slashCommands: CommandInfo[];
  commandsLoaded?: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange?: (value: string) => void;
}

interface UseSlashCommandsReturn {
  slashMenuOpen: boolean;
  slashFilter: string;
  commandsReady: boolean;
  paletteRef: React.RefObject<SlashCommandPaletteHandle | null>;
  handleInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleSlashCommandSelect: (command: CommandInfo) => void;
  handleSlashMenuClose: () => void;
  /** Call from keydown handler to check if slash menu should handle the key */
  delegateToSlashMenu: (key: string) => SlashKeyResult;
}

/**
 * Manages slash command palette state, detection, and keyboard delegation.
 */
export function useSlashCommands({
  slashCommands,
  commandsLoaded = false,
  inputRef,
  onChange,
}: UseSlashCommandsOptions): UseSlashCommandsReturn {
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const paletteRef = useRef<SlashCommandPaletteHandle>(null);
  const commandsReady = commandsLoaded || slashCommands.length > 0;

  // Re-evaluate slash menu when commands arrive (handles typing "/" before commands load)
  useEffect(() => {
    if (slashCommands.length === 0 || !inputRef?.current) {
      return;
    }
    const currentValue = inputRef.current.value;
    if (!currentValue.startsWith('/')) {
      return;
    }
    const afterSlash = currentValue.slice(1);
    const spaceIndex = afterSlash.indexOf(' ');
    // Only open if still completing command name (no space yet)
    if (spaceIndex === -1) {
      setSlashFilter(afterSlash);
      setSlashMenuOpen(true);
    }
  }, [slashCommands.length, inputRef]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      onChange?.(newValue);

      // Detect slash command at start of input
      if (newValue.startsWith('/')) {
        // Extract the text after / (before any space)
        const afterSlash = newValue.slice(1);
        const spaceIndex = afterSlash.indexOf(' ');
        const filter = spaceIndex === -1 ? afterSlash : afterSlash.slice(0, spaceIndex);

        // Only show menu if no space yet (still completing command name)
        if (spaceIndex === -1) {
          setSlashFilter(filter);
          setSlashMenuOpen(true);
        } else {
          setSlashMenuOpen(false);
        }
      } else {
        setSlashMenuOpen(false);
        setSlashFilter('');
      }
    },
    [onChange]
  );

  const handleSlashCommandSelect = useCallback(
    (command: CommandInfo) => {
      // Replace input with /<command-name> followed by a space
      const newValue = `/${command.name} `;
      if (inputRef?.current) {
        inputRef.current.value = newValue;
        inputRef.current.focus();
        // Move cursor to end
        inputRef.current.setSelectionRange(newValue.length, newValue.length);
      }
      onChange?.(newValue);
      setSlashMenuOpen(false);
      setSlashFilter('');
    },
    [inputRef, onChange]
  );

  const handleSlashMenuClose = useCallback(() => {
    setSlashMenuOpen(false);
    setSlashFilter('');
  }, []);

  const delegateToSlashMenu = useCallback(
    (key: string): SlashKeyResult => {
      if (!(slashMenuOpen && paletteRef.current)) {
        return 'passthrough';
      }
      const result = paletteRef.current.handleKeyDown(key);
      if (result === 'close-and-passthrough') {
        setSlashMenuOpen(false);
      }
      return result;
    },
    [slashMenuOpen]
  );

  return {
    slashMenuOpen,
    slashFilter,
    commandsReady,
    paletteRef,
    handleInputChange,
    handleSlashCommandSelect,
    handleSlashMenuClose,
    delegateToSlashMenu,
  };
}
