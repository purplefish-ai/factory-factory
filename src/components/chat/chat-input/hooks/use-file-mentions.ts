import { useCallback, useMemo, useRef, useState } from 'react';
import { trpc } from '@/client/lib/trpc';
import type {
  FileMentionKeyResult,
  FileMentionPaletteHandle,
} from '@/components/chat/file-mention-palette';

interface UseFileMentionsOptions {
  workspaceId: string | undefined;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange?: (value: string) => void;
}

interface UseFileMentionsReturn {
  fileMentionMenuOpen: boolean;
  fileMentionFilter: string;
  files: string[];
  filesLoading: boolean;
  paletteRef: React.RefObject<FileMentionPaletteHandle | null>;
  handleFileMentionSelect: (filePath: string) => void;
  handleFileMentionMenuClose: () => void;
  /** Call from keydown handler to check if file mention menu should handle the key */
  delegateToFileMentionMenu: (key: string) => FileMentionKeyResult;
  /** Call this from the input change handler to detect @ mentions */
  detectFileMention: (newValue: string) => void;
}

/**
 * Manages file mention palette state, detection, and keyboard delegation.
 * Detects @ symbol followed by text and shows a file picker autocomplete.
 */
export function useFileMentions({
  workspaceId,
  inputRef,
  onChange,
}: UseFileMentionsOptions): UseFileMentionsReturn {
  const [fileMentionMenuOpen, setFileMentionMenuOpen] = useState(false);
  const [fileMentionFilter, setFileMentionFilter] = useState('');
  const [mentionStartPos, setMentionStartPos] = useState(0);
  const paletteRef = useRef<FileMentionPaletteHandle>(null);

  // Fetch files from backend with debouncing via tRPC's built-in caching
  const { data: filesData, isLoading: filesLoading } = trpc.workspace.listAllFiles.useQuery(
    {
      workspaceId: workspaceId ?? '',
      query: fileMentionFilter,
      limit: 50,
    },
    {
      enabled: fileMentionMenuOpen && !!workspaceId,
      staleTime: 30_000, // Cache for 30 seconds
    }
  );

  const files = useMemo(() => filesData?.files ?? [], [filesData]);

  /**
   * Find @ position by looking backwards from cursor
   */
  const findAtPosition = useCallback((text: string, cursorPos: number): number => {
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = text[i];
      if (char === ' ' || char === '\n' || char === '\t') {
        return -1;
      }
      if (char === '@') {
        return i;
      }
    }
    return -1;
  }, []);

  /**
   * Check if @ is at valid position (start or after whitespace)
   */
  const isValidAtPosition = useCallback((text: string, atPos: number): boolean => {
    if (atPos === 0) {
      return true;
    }
    const charBefore = text[atPos - 1];
    return charBefore === ' ' || charBefore === '\n' || charBefore === '\t';
  }, []);

  /**
   * Detect @ mentions in the input value.
   * Called from the parent input change handler.
   */
  const detectFileMention = useCallback(
    (newValue: string) => {
      if (!inputRef.current) {
        return;
      }

      const cursorPos = inputRef.current.selectionStart ?? newValue.length;
      const atPos = findAtPosition(newValue, cursorPos);

      if (atPos !== -1 && isValidAtPosition(newValue, atPos)) {
        const filter = newValue.slice(atPos + 1, cursorPos);
        setFileMentionFilter(filter);
        setMentionStartPos(atPos);
        setFileMentionMenuOpen(true);
        return;
      }

      // No valid @ mention found
      setFileMentionMenuOpen(false);
      setFileMentionFilter('');
    },
    [inputRef, findAtPosition, isValidAtPosition]
  );

  const handleFileMentionSelect = useCallback(
    (filePath: string) => {
      if (!inputRef.current) {
        return;
      }

      const currentValue = inputRef.current.value;
      const cursorPos = inputRef.current.selectionStart ?? currentValue.length;

      // Replace from @ to cursor with the selected file path
      const before = currentValue.slice(0, mentionStartPos);
      const after = currentValue.slice(cursorPos);
      const newValue = `${before}@${filePath} ${after}`;

      inputRef.current.value = newValue;
      inputRef.current.focus();

      // Move cursor after the inserted file path + space
      const newCursorPos = mentionStartPos + filePath.length + 2; // +2 for @ and space
      inputRef.current.setSelectionRange(newCursorPos, newCursorPos);

      onChange?.(newValue);
      setFileMentionMenuOpen(false);
      setFileMentionFilter('');
    },
    [inputRef, onChange, mentionStartPos]
  );

  const handleFileMentionMenuClose = useCallback(() => {
    setFileMentionMenuOpen(false);
    setFileMentionFilter('');
  }, []);

  const delegateToFileMentionMenu = useCallback(
    (key: string): FileMentionKeyResult => {
      if (!(fileMentionMenuOpen && paletteRef.current)) {
        return 'passthrough';
      }
      const result = paletteRef.current.handleKeyDown(key);
      if (result === 'close-and-passthrough') {
        setFileMentionMenuOpen(false);
      }
      return result;
    },
    [fileMentionMenuOpen]
  );

  return {
    fileMentionMenuOpen,
    fileMentionFilter,
    files,
    filesLoading,
    paletteRef,
    handleFileMentionSelect,
    handleFileMentionMenuClose,
    delegateToFileMentionMenu,
    detectFileMention,
  };
}
