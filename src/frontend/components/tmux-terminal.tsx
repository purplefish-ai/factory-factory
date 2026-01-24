'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '../lib/trpc';

interface TmuxTerminalProps {
  sessionName: string;
  agentId?: string;
  refreshInterval?: number;
}

export function TmuxTerminal({ sessionName, agentId, refreshInterval = 2000 }: TmuxTerminalProps) {
  const terminalRef = useRef<HTMLPreElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const { data, isLoading, error, refetch } = trpc.agent.getTerminalOutput.useQuery(
    agentId ? { agentId } : { sessionName },
    { refetchInterval: refreshInterval }
  );

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [autoScroll]);

  // Handle scroll to detect if user scrolled up
  const handleScroll = () => {
    if (terminalRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = terminalRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      setAutoScroll(isAtBottom);
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 bg-gray-900 text-gray-300 rounded h-96 flex items-center justify-center">
        <div className="animate-pulse">Loading terminal session...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-900 text-red-200 rounded">
        <p className="font-medium">Error loading terminal</p>
        <p className="text-sm mt-1">{error.message}</p>
        <button
          onClick={() => refetch()}
          className="mt-2 px-3 py-1 bg-red-800 rounded text-sm hover:bg-red-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Terminal Header */}
      <div className="flex items-center justify-between bg-gray-800 text-gray-300 px-4 py-2 rounded-t text-sm">
        <div className="flex items-center gap-2">
          <span className="flex gap-1.5">
            <span className="w-3 h-3 rounded-full bg-red-500" />
            <span className="w-3 h-3 rounded-full bg-yellow-500" />
            <span className="w-3 h-3 rounded-full bg-green-500" />
          </span>
          <span className="ml-2 font-mono text-xs">{data?.sessionName || sessionName}</span>
        </div>
        <div className="flex items-center gap-2">
          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                if (terminalRef.current) {
                  terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
                }
              }}
              className="px-2 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
            >
              Scroll to bottom
            </button>
          )}
          <button
            onClick={() => refetch()}
            className="px-2 py-1 bg-gray-700 rounded text-xs hover:bg-gray-600"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Terminal Content */}
      <pre
        ref={terminalRef}
        onScroll={handleScroll}
        className="bg-black text-green-400 font-mono text-sm p-4 rounded-b overflow-auto h-96 whitespace-pre-wrap"
      >
        {data?.output || 'No output yet...'}
      </pre>

      {/* Auto-scroll indicator */}
      <div className="absolute bottom-2 right-2">
        {autoScroll ? (
          <span className="text-xs text-gray-500 bg-black/50 px-2 py-1 rounded">
            Auto-scrolling
          </span>
        ) : (
          <span className="text-xs text-yellow-500 bg-black/50 px-2 py-1 rounded">
            Paused (scroll up detected)
          </span>
        )}
      </div>
    </div>
  );
}
