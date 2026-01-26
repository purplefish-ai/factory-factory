'use client';

import { useCallback, useEffect, useRef } from 'react';

// =============================================================================
// Types
// =============================================================================

interface TerminalInstanceProps {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  output: string;
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function TerminalInstance({ onData, onResize, output, className }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitAddonRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const lastOutputLengthRef = useRef(0);

  // Store callbacks in refs to avoid reinitializing terminal when they change
  // This is critical because onData/onResize depend on parent state (tabs)
  // and would otherwise cause the terminal to dispose/recreate on every output
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);

  useEffect(() => {
    onDataRef.current = onData;
    onResizeRef.current = onResize;
  }, [onData, onResize]);

  // Initialize terminal
  useEffect(() => {
    let terminal: import('@xterm/xterm').Terminal | null = null;
    let fitAddon: import('@xterm/addon-fit').FitAddon | null = null;

    const initTerminal = async () => {
      if (!containerRef.current) {
        return;
      }

      // Dynamically import xterm to avoid SSR issues - these must be dynamic imports
      // because xterm requires DOM APIs that aren't available during server-side rendering
      // biome-ignore lint/plugin: dynamic import required to avoid SSR issues with xterm
      const { Terminal } = await import('@xterm/xterm');
      // biome-ignore lint/plugin: dynamic import required to avoid SSR issues with xterm
      const { FitAddon } = await import('@xterm/addon-fit');

      // Import CSS dynamically
      // @ts-expect-error CSS imports are handled by bundler
      // biome-ignore lint/plugin: dynamic import required for CSS in client component
      await import('@xterm/xterm/css/xterm.css');

      terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: '#18181b', // zinc-900
          foreground: '#fafafa', // zinc-50
          cursor: '#fafafa',
          cursorAccent: '#18181b',
          selectionBackground: '#3f3f46', // zinc-700
          black: '#18181b',
          red: '#ef4444',
          green: '#22c55e',
          yellow: '#eab308',
          blue: '#3b82f6',
          magenta: '#a855f7',
          cyan: '#06b6d4',
          white: '#fafafa',
          brightBlack: '#71717a',
          brightRed: '#f87171',
          brightGreen: '#4ade80',
          brightYellow: '#facc15',
          brightBlue: '#60a5fa',
          brightMagenta: '#c084fc',
          brightCyan: '#22d3ee',
          brightWhite: '#ffffff',
        },
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      terminal.open(containerRef.current);
      fitAddon.fit();

      // Store refs
      terminalRef.current = terminal;
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

      resizeObserver.observe(containerRef.current);

      // Cleanup on unmount
      return () => {
        resizeObserver.disconnect();
        terminal?.dispose();
      };
    };

    const cleanup = initTerminal();

    return () => {
      cleanup.then((cleanupFn) => cleanupFn?.());
    };
  }, []); // Empty deps - only run once on mount

  // Write output to terminal
  useEffect(() => {
    if (terminalRef.current && output.length > lastOutputLengthRef.current) {
      const newOutput = output.slice(lastOutputLengthRef.current);
      terminalRef.current.write(newOutput);
      lastOutputLengthRef.current = output.length;
    }
  }, [output]);

  // Focus terminal on click
  const handleClick = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  return (
    // biome-ignore lint/a11y/useSemanticElements: terminal requires custom element for xterm.js
    <div
      ref={containerRef}
      className={className}
      onClick={handleClick}
      onKeyDown={handleClick}
      role="textbox"
      tabIndex={0}
      aria-label="Terminal"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
