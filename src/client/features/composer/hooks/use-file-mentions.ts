import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  FileMentionKeyResult,
  FileMentionPaletteHandle,
} from '@/client/features/composer/file-mention-palette';

const FILE_LIST_LIMIT = 50;
const FILE_LIST_STALE_TIME_MS = 30_000;

/**
 * The tRPC file-list procedure the palette searches, such as
 * `trpc.workspace.listAllFiles` or `trpc.project.listAllFiles`.
 */
export interface FileMentionFileQuery<TScope> {
  useQuery: (
    input: TScope & { query: string; limit: number },
    options: { enabled: boolean; staleTime: number }
  ) => {
    data: { files: string[] } | undefined;
    isLoading: boolean;
    error: { message: string } | null;
  };
}

interface UseFileMentionsOptions<TScope> {
  /** The procedure that lists files; keep it the same for the component's lifetime. */
  fileQuery: FileMentionFileQuery<TScope>;
  /** The procedure input that selects the repository, such as `{ projectId }`. */
  scope: TScope;
  /** False while the scope is not known yet; the file list is not fetched. */
  scopeReady: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange?: (value: string) => void;
}

interface UseFileMentionsReturn {
  fileMentionMenuOpen: boolean;
  fileMentionFilter: string;
  files: string[];
  filesLoading: boolean;
  /** The file list failed to load; the palette shows it instead of "No files found". */
  filesError: string | null;
  paletteRef: React.RefObject<FileMentionPaletteHandle | null>;
  handleFileMentionSelect: (filePath: string) => void;
  handleFileMentionMenuClose: () => void;
  /** Call from keydown handler to check if file mention menu should handle the key */
  delegateToFileMentionMenu: (key: string) => FileMentionKeyResult;
  /** Call this from the input change handler to detect @ mentions */
  detectFileMention: (newValue: string) => void;
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\t';
}

/** Find the @ before the cursor, or -1 when whitespace comes first. */
function findAtPosition(text: string, cursorPos: number): number {
  for (let i = cursorPos - 1; i >= 0; i--) {
    const char = text[i];
    if (isWhitespace(char)) {
      return -1;
    }
    if (char === '@') {
      return i;
    }
  }
  return -1;
}

/** An @ starts a mention at the start of the text or after whitespace. */
function isValidAtPosition(text: string, atPos: number): boolean {
  return atPos === 0 || isWhitespace(text[atPos - 1]);
}

/**
 * Manages file mention palette state, detection, and keyboard delegation.
 * Detects @ symbol followed by text and shows a file picker autocomplete over
 * the files `fileQuery` lists for `scope`.
 */
export function useFileMentions<TScope>({
  fileQuery,
  scope,
  scopeReady,
  inputRef,
  onChange,
}: UseFileMentionsOptions<TScope>): UseFileMentionsReturn {
  const [fileMentionMenuOpen, setFileMentionMenuOpen] = useState(false);
  const [fileMentionFilter, setFileMentionFilter] = useState('');
  const paletteRef = useRef<FileMentionPaletteHandle>(null);

  const {
    data: filesData,
    isLoading: filesLoading,
    error,
  } = fileQuery.useQuery(
    { ...scope, query: fileMentionFilter, limit: FILE_LIST_LIMIT },
    { enabled: fileMentionMenuOpen && scopeReady, staleTime: FILE_LIST_STALE_TIME_MS }
  );

  const files = useMemo(() => filesData?.files ?? [], [filesData]);

  const closeMenu = useCallback(() => {
    setFileMentionMenuOpen(false);
    setFileMentionFilter('');
  }, []);

  const detectFileMention = useCallback(
    (newValue: string) => {
      if (!inputRef.current) {
        return;
      }

      const cursorPos = inputRef.current.selectionStart ?? newValue.length;
      const atPos = findAtPosition(newValue, cursorPos);

      if (atPos !== -1 && isValidAtPosition(newValue, atPos)) {
        setFileMentionFilter(newValue.slice(atPos + 1, cursorPos));
        setFileMentionMenuOpen(true);
        return;
      }

      closeMenu();
    },
    [inputRef, closeMenu]
  );

  const handleFileMentionSelect = useCallback(
    (filePath: string) => {
      if (!inputRef.current) {
        return;
      }

      const currentValue = inputRef.current.value;
      const cursorPos = inputRef.current.selectionStart ?? currentValue.length;
      const atPos = findAtPosition(currentValue, cursorPos);
      const charAtCursor = currentValue[cursorPos];
      const cursorAtMentionEnd =
        inputRef.current.selectionStart === inputRef.current.selectionEnd &&
        (charAtCursor === undefined || isWhitespace(charAtCursor));

      if (atPos === -1 || !isValidAtPosition(currentValue, atPos) || !cursorAtMentionEnd) {
        closeMenu();
        return;
      }

      // Replace from @ to cursor with the selected file path
      const before = currentValue.slice(0, atPos);
      const after = currentValue.slice(cursorPos);
      const trailingSpace = charAtCursor === undefined ? ' ' : '';
      const newValue = `${before}@${filePath}${trailingSpace}${after}`;

      inputRef.current.value = newValue;
      inputRef.current.focus();

      // Move the cursor after the inserted file path and any added space
      const newCursorPos = atPos + filePath.length + 1 + trailingSpace.length;
      inputRef.current.setSelectionRange(newCursorPos, newCursorPos);

      onChange?.(newValue);
      closeMenu();
    },
    [inputRef, onChange, closeMenu]
  );

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
    filesError: error?.message ?? null,
    paletteRef,
    handleFileMentionSelect,
    handleFileMentionMenuClose: closeMenu,
    delegateToFileMentionMenu,
    detectFileMention,
  };
}
