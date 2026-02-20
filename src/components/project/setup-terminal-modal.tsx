import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TerminalInstance } from '@/components/workspace/terminal-instance';
import { buildWebSocketUrl } from '@/lib/websocket-config';

const SetupTerminalMessageSchema = z.object({
  type: z.string(),
  data: z.string().optional(),
  message: z.string().optional(),
});

interface SetupTerminalModalProps {
  open: boolean;
  onClose: () => void;
}

export function SetupTerminalModal({ open, onClose }: SetupTerminalModalProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const [output, setOutput] = useState('');
  const [connected, setConnected] = useState(false);
  const colsRef = useRef(80);
  const rowsRef = useRef(24);

  // Connect WebSocket when modal opens
  useEffect(() => {
    if (!open) {
      // Clean up when closed
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setOutput('');
      setConnected(false);
      return;
    }

    const url = buildWebSocketUrl('/setup-terminal', {});
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Request terminal creation
      ws.send(
        JSON.stringify({
          type: 'create',
          cols: colsRef.current,
          rows: rowsRef.current,
        })
      );
    };

    ws.onmessage = (event) => {
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        const msg = SetupTerminalMessageSchema.parse(parsed);

        if (msg.type === 'output' && msg.data) {
          setOutput((prev) => prev + msg.data);
        }
      } catch {
        // Ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [open]);

  const handleData = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data }));
    }
  }, []);

  const handleResize = useCallback((cols: number, rows: number) => {
    colsRef.current = cols;
    rowsRef.current = rows;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-3xl h-[500px] flex flex-col">
        <DialogHeader>
          <DialogTitle>Terminal</DialogTitle>
          <DialogDescription>
            Run{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">gh auth login</code> to
            authenticate with GitHub, then close this dialog.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 rounded-md overflow-hidden border bg-[#18181b]">
          {connected && (
            <TerminalInstance
              onData={handleData}
              onResize={handleResize}
              output={output}
              isActive={open}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
