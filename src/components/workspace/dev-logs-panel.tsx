import { useRef } from 'react';
import { cn } from '@/lib/utils';

interface DevLogsPanelProps {
  output: string;
  outputEndRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
  emptyMessage?: string;
}

export function DevLogsPanel({
  output,
  outputEndRef,
  className,
  emptyMessage = 'Waiting for dev server output...',
}: DevLogsPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div className={cn('h-full bg-background', className)}>
      {/* Output - no header, connection status is shown in the tab bar */}
      <div
        ref={containerRef}
        className="h-full overflow-y-auto overflow-x-auto font-mono text-xs p-4 bg-black text-white"
      >
        <pre className="whitespace-pre-wrap break-words">{output || emptyMessage}</pre>
        <div ref={outputEndRef} />
      </div>
    </div>
  );
}
