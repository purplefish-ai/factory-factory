import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface DevLogsPanelProps {
  workspaceId: string;
  className?: string;
}

export function DevLogsPanel({ workspaceId, className }: DevLogsPanelProps) {
  const [output, setOutput] = useState<string>('');
  const wsRef = useRef<WebSocket | null>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Connect to dev logs WebSocket
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/dev-logs?workspaceId=${workspaceId}`;

    // Add debug output to help diagnose connection issues
    setOutput(`Connecting to ${wsUrl}...\n`);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setOutput((prev) => `${prev}Connected!\n\n`);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'output') {
          setOutput((prev) => prev + message.data);
          // Scroll to bottom after a short delay to allow render
          setTimeout(scrollToBottom, 10);
        } else if (message.type === 'status') {
          setOutput((prev) => `${prev}Status: ${JSON.stringify(message)}\n`);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onerror = () => {
      setOutput((prev) => `${prev}WebSocket error occurred\n`);
    };

    ws.onclose = (event) => {
      setOutput((prev) => `${prev}Disconnected (code: ${event.code})\n`);
    };

    return () => {
      ws.close();
    };
  }, [workspaceId, scrollToBottom]);

  return (
    <div className={cn('h-full bg-background', className)}>
      {/* Output - no header, connection status is shown in the tab bar */}
      <div
        ref={containerRef}
        className="h-full overflow-y-auto overflow-x-auto font-mono text-xs p-4 bg-black text-white"
      >
        <pre className="whitespace-pre-wrap break-words">
          {output || 'Waiting for dev server output...'}
        </pre>
        <div ref={outputEndRef} />
      </div>
    </div>
  );
}
