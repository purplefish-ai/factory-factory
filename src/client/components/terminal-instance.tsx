import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef } from 'react';
import { useAppearance } from '@/client/components/appearance-provider';
import { WORKSPACE_DRAWER_BREAKPOINT } from '@/client/hooks/use-workspace-drawer';
import type { TerminalOutputStream } from '@/client/lib/terminal-output-stream';
import { scaledTerminalFontSize } from '@/shared/appearance';
import { readTerminalTheme } from './terminal-theme';

const MANUAL_FOCUS_MEDIA_QUERY = `(max-width: ${WORKSPACE_DRAWER_BREAKPOINT - 1}px), (any-pointer: coarse)`;

const DEFAULT_TERMINAL_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace';

// Erase the screen (ED 2) and scrollback (ED 3), then home the cursor. Sent
// through write() so it is parsed after any chunks still queued in xterm;
// terminal.clear() would run synchronously, ahead of them.
export const TERMINAL_CLEAR_SEQUENCE = '\x1b[2J\x1b[3J\x1b[H';

// =============================================================================
// Types
// =============================================================================

interface TerminalInstanceProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /**
   * Output source. Its snapshot is replayed on mount; later chunks are written
   * straight to xterm without re-rendering this component.
   */
  output: TerminalOutputStream;
  className?: string;
  /** Explicit focus request, e.g. for the setup dialog. Workspace terminals omit this. */
  isActive?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function TerminalInstance({
  onData,
  onResize,
  output,
  className,
  isActive,
}: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // The stream whose output this xterm instance currently holds, if any.
  const attachedOutputRef = useRef<TerminalOutputStream | null>(null);

  // Store callbacks in refs to avoid reinitializing terminal when they change
  // This is critical because onData/onResize depend on parent state (tabs)
  // and would otherwise cause the terminal to dispose/recreate on every output
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);

  useEffect(() => {
    onDataRef.current = onData;
    onResizeRef.current = onResize;
  }, [onData, onResize]);

  // xterm sizes text in pixels, so the appearance font scale and monospace
  // font are applied here rather than through CSS.
  const appearance = useAppearance();
  const fontSize = scaledTerminalFontSize(appearance.fontScale);
  const fontFamily = appearance.fontMono ?? DEFAULT_TERMINAL_FONT_FAMILY;
  // The mount-only effect below only ever sees the first render's values; a
  // later change is applied by the font effect further down.
  const initialFontOptionsRef = useRef({ fontSize, fontFamily });

  // Initialize terminal synchronously
  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: initialFontOptionsRef.current.fontSize,
      fontFamily: initialFontOptionsRef.current.fontFamily,
      theme: readTerminalTheme(),
      minimumContrastRatio: 4.5,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    // Store refs
    terminalRef.current = terminal;
    // Appearance preferences and next-themes update these root attributes.
    // Updating xterm options preserves the buffer, selection and PTY session.
    const updateTheme = () => {
      terminal.options.theme = readTerminalTheme();
      terminal.options.minimumContrastRatio =
        document.documentElement.getAttribute('data-color-scheme') === 'high-contrast' ? 7 : 4.5;
    };
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-color-scheme'],
    });
    updateTheme();
    fitAddonRef.current = fitAddon;

    // Report initial size via ref to get latest callback
    onResizeRef.current(terminal.cols, terminal.rows);

    // Handle user input via ref to always use latest callback
    terminal.onData((data) => {
      onDataRef.current(data);
    });

    // Handle resize via ref to always use latest callback
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current && terminalRef.current) {
        fitAddonRef.current.fit();
        onResizeRef.current(terminalRef.current.cols, terminalRef.current.rows);
      }
    });

    resizeObserverRef.current = resizeObserver;
    resizeObserver.observe(containerRef.current);

    // Cleanup on unmount
    return () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      attachedOutputRef.current = null;
    };
  }, []);

  // Re-measure when the appearance font settings change after mount.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (terminal.options.fontSize === fontSize && terminal.options.fontFamily === fontFamily) {
      return;
    }
    terminal.options.fontSize = fontSize;
    terminal.options.fontFamily = fontFamily;
    fitAddonRef.current?.fit();
    onResizeRef.current(terminal.cols, terminal.rows);
  }, [fontSize, fontFamily]);

  // Replay the stream's rolling window, then write each new chunk directly.
  // xterm keeps its own scrollback, so appends never clear or rewrite it.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    // A fresh xterm is empty; one that already shows another stream is cleared.
    const clearPrefix = attachedOutputRef.current === null ? '' : TERMINAL_CLEAR_SEQUENCE;
    attachedOutputRef.current = output;
    const replay = clearPrefix + output.snapshot();
    if (replay.length > 0) {
      terminal.write(replay);
    }
    return output.subscribe((event) => {
      // A reset means the retained output was replaced, e.g. by a reconnect
      // buffer that does not extend what this terminal already shows.
      terminal.write(event.type === 'append' ? event.data : TERMINAL_CLEAR_SEQUENCE + event.output);
    });
  }, [output]);

  // Focus terminal when it becomes active (e.g., tab switch)
  useEffect(() => {
    if (isActive && terminalRef.current && !window.matchMedia(MANUAL_FOCUS_MEDIA_QUERY).matches) {
      terminalRef.current.focus();
    }
  }, [isActive]);

  // Click-to-focus: ensure clicking anywhere in the terminal area focuses the
  // hidden textarea so keyboard input is captured by xterm.js
  const handleClick = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Terminal"
      className={className}
      style={{ width: '100%', height: '100%' }}
      onClick={handleClick}
      onKeyDown={handleClick}
    />
  );
}
