import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  FileMentionKeyResult,
  FileMentionPaletteHandle,
} from '@/components/chat/file-mention-palette';
import { trpc } from '@/frontend/lib/trpc';

interface UseProjectFileMentionsOptions {
  projectId: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange?: (value: string) => void;
}

interface UseProjectFileMentionsReturn {
  fileMentionMenuOpen: boolean;
  fileMentionFilter: string;
  files: string[];
  filesLoading: boolean;
  paletteRef: React.RefObject<FileMentionPaletteHandle | null>;
  handleFileMentionSelect: (filePath: string) => void;
  handleFileMentionMenuClose: () => void;
  delegateToFileMentionMenu: (key: string) => FileMentionKeyResult;
  detectFileMention: (newValue: string) => void;
}

/**
 * Manages file mention palette state for project-level file references.
 * Uses project.listAllFiles (project repo) instead of workspace.listAllFiles.
 */
export function useProjectFileMentions({
  projectId,
  inputRef,
  onChange,
}: UseProjectFileMentionsOptions): UseProjectFileMentionsReturn {
  const [fileMentionMenuOpen, setFileMentionMenuOpen] = useState(false);
  const [fileMentionFilter, setFileMentionFilter] = useState('');
  const [mentionStartPos, setMentionStartPos] = useState(0);
  const paletteRef = useRef<FileMentionPaletteHandle>(null);

  const { data: filesData, isLoading: filesLoading } = trpc.project.listAllFiles.useQuery(
    {
      projectId,
      query: fileMentionFilter,
      limit: 50,
    },
    {
      enabled: fileMentionMenuOpen && !!projectId,
      staleTime: 30_000,
    }
  );

  const files = useMemo(() => filesData?.files ?? [], [filesData]);

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

  const isValidAtPosition = useCallback((text: string, atPos: number): boolean => {
    if (atPos === 0) {
      return true;
    }
    const charBefore = text[atPos - 1];
    return charBefore === ' ' || charBefore === '\n' || charBefore === '\t';
  }, []);

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

      const before = currentValue.slice(0, mentionStartPos);
      const after = currentValue.slice(cursorPos);
      const newValue = `${before}@${filePath} ${after}`;

      inputRef.current.value = newValue;
      inputRef.current.focus();

      const newCursorPos = mentionStartPos + filePath.length + 2;
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
