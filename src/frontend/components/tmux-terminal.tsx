'use client';

import { useEffect, useState } from 'react';

/**
 * Simple tmux terminal viewer component
 * This is a Phase 1 placeholder - full xterm.js integration will be done later
 */
interface TmuxTerminalProps {
  sessionName: string;
  refreshInterval?: number; // milliseconds
}

export function TmuxTerminal({
  sessionName,
  refreshInterval = 2000,
}: TmuxTerminalProps) {
  const [output, setOutput] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchOutput = async () => {
      try {
        const response = await fetch(
          `/api/terminal/session/${sessionName}/output`
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch session output: ${response.statusText}`);
        }

        const data = await response.json();
        setOutput(data.output);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    // Initial fetch
    fetchOutput();

    // Set up polling
    const interval = setInterval(fetchOutput, refreshInterval);

    return () => clearInterval(interval);
  }, [sessionName, refreshInterval]);

  if (loading) {
    return (
      <div className="p-4 bg-gray-900 text-gray-300 rounded">
        <p>Loading terminal session...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-900 text-red-200 rounded">
        <p>Error: {error}</p>
      </div>
    );
  }

  return (
    <div className="bg-black text-green-400 font-mono text-sm p-4 rounded overflow-auto max-h-[600px]">
      <div className="mb-2 text-gray-500">
        Session: {sessionName}
      </div>
      <pre className="whitespace-pre-wrap">{output}</pre>
    </div>
  );
}
