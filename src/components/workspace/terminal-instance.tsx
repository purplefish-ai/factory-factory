'use client';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useRef } from 'react';

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

  // Initialize terminal synchronously
  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const terminal = new Terminal({
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

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();
    terminal.focus();

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

    resizeObserverRef.current = resizeObserver;
    resizeObserver.observe(containerRef.current);

    // Cleanup on unmount
    return () => {
      resizeObserver.disconnect();
      resizeObserverRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []); // Empty deps - only run once on mount

  // Write output to terminal
  useEffect(() => {
    if (!terminalRef.current) {
      return;
    }

    // Handle output reset (e.g., when switching tabs or clearing)
    if (output.length < lastOutputLengthRef.current) {
      terminalRef.current.clear();
      lastOutputLengthRef.current = 0;
      // If there's new output after reset, write it
      if (output.length > 0) {
        terminalRef.current.write(output);
        lastOutputLengthRef.current = output.length;
      }
      return;
    }

    // Handle new output appended
    if (output.length > lastOutputLengthRef.current) {
      const newOutput = output.slice(lastOutputLengthRef.current);
      terminalRef.current.write(newOutput);
      lastOutputLengthRef.current = output.length;
    }
  }, [output]);

  // Focus terminal when it becomes active (e.g., tab switch)
  useEffect(() => {
    if (isActive && terminalRef.current) {
      terminalRef.current.focus();
    }
  }, [isActive]);

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
