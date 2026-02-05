import { AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { useRef } from 'react';
import { cn } from '@/lib/utils';

type WorkspaceStatus = 'NEW' | 'PROVISIONING' | 'READY' | 'FAILED' | 'ARCHIVED';

interface InitLogsPanelProps {
  output: string;
  status: WorkspaceStatus | null;
  errorMessage: string | null;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
}

export function InitLogsPanel({
  output,
  status,
  errorMessage,
  outputEndRef,
  className,
}: InitLogsPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div className={cn('h-full flex flex-col bg-background', className)}>
      {/* Status banner at top */}
      {status === 'PROVISIONING' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-500/10 border-b border-blue-500/20 flex-shrink-0">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
          <span className="text-sm text-blue-400">Running setup script...</span>
        </div>
      )}
      {status === 'READY' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-500/10 border-b border-green-500/20 flex-shrink-0">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="text-sm text-green-400">Setup complete</span>
        </div>
      )}
      {status === 'FAILED' && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 border-b border-red-500/20 flex-shrink-0">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <span className="text-sm text-red-400 truncate">
            Setup failed{errorMessage ? `: ${errorMessage}` : ''}
          </span>
        </div>
      )}

      {/* Output log */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-auto font-mono text-xs p-4 bg-black text-white"
      >
        <pre className="whitespace-pre-wrap break-words">
          {output || (
            <span className="text-zinc-500 italic">Waiting for setup script output...</span>
          )}
        </pre>
        <div ref={outputEndRef} />
      </div>
    </div>
  );
}
