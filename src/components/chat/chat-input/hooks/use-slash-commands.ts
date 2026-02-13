import type { ChangeEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SlashCommandPaletteHandle,
  SlashKeyResult,
} from '@/components/chat/slash-command-palette';
import type { CommandInfo } from '@/lib/chat-protocol';

interface UseSlashCommandsOptions {
  enabled?: boolean;
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
  enabled = true,
  slashCommands,
  commandsLoaded = false,
  inputRef,
  onChange,
}: UseSlashCommandsOptions): UseSlashCommandsReturn {
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const paletteRef = useRef<SlashCommandPaletteHandle>(null);
  const commandsReady = !enabled || commandsLoaded || slashCommands.length > 0;

  useEffect(() => {
    if (enabled) {
      return;
    }
    setSlashMenuOpen(false);
    setSlashFilter('');
  }, [enabled]);

  // Re-evaluate slash menu when commands arrive (handles typing "/" before commands load)
  useEffect(() => {
    if (!enabled || slashCommands.length === 0 || !inputRef?.current) {
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
  }, [enabled, slashCommands.length, inputRef]);

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = event.target.value;
      onChange?.(newValue);

      if (!enabled) {
        setSlashMenuOpen(false);
        setSlashFilter('');
        return;
      }

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
    [enabled, onChange]
  );

  const handleSlashCommandSelect = useCallback(
    (command: CommandInfo) => {
      if (!enabled) {
        return;
      }
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
    [enabled, inputRef, onChange]
  );

  const handleSlashMenuClose = useCallback(() => {
    setSlashMenuOpen(false);
    setSlashFilter('');
  }, []);

  const delegateToSlashMenu = useCallback(
    (key: string): SlashKeyResult => {
      if (!(enabled && slashMenuOpen && paletteRef.current)) {
        return 'passthrough';
      }
      const result = paletteRef.current.handleKeyDown(key);
      if (result === 'close-and-passthrough') {
        setSlashMenuOpen(false);
      }
      return result;
    },
    [enabled, slashMenuOpen]
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
