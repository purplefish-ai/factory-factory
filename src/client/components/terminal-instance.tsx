import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef } from 'react';
import { useAppearance } from '@/client/components/appearance-provider';
import { WORKSPACE_DRAWER_BREAKPOINT } from '@/client/hooks/use-workspace-drawer';
import { scaledTerminalFontSize } from '@/shared/appearance';
import { readTerminalTheme } from './terminal-theme';

const MANUAL_FOCUS_MEDIA_QUERY = `(max-width: ${WORKSPACE_DRAWER_BREAKPOINT - 1}px), (any-pointer: coarse)`;

const DEFAULT_TERMINAL_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace';

// =============================================================================
// Types
// =============================================================================

interface TerminalInstanceProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  output: string;
  className?: string;
  /** When true, the terminal will receive focus */
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
  const lastOutputRef = useRef('');
  const initialOutputRef = useRef(output);

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
    if (!window.matchMedia(MANUAL_FOCUS_MEDIA_QUERY).matches) {
      terminal.focus();
    }

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

    // Write initial output captured at mount time to avoid re-initializing on every update.
    if (initialOutputRef.current) {
      terminal.write(initialOutputRef.current);
      lastOutputRef.current = initialOutputRef.current;
    }

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

  // Write output to terminal
  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    const lastOutput = lastOutputRef.current;

    if (output === lastOutput) {
      return;
    }

    // Handle new output appended.
    if (output.startsWith(lastOutput)) {
      const newOutput = output.slice(lastOutput.length);
      terminalRef.current.write(newOutput);
      lastOutputRef.current = output;
      return;
    }

    // Handle output reset or rolling-buffer rewrites after truncation.
    terminalRef.current.clear();
    if (output.length > 0) {
      terminalRef.current.write(output);
    }
    lastOutputRef.current = output;
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
