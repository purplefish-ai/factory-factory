import { useFollowOutput } from '@/client/hooks/use-follow-output';
import { cn } from '@/lib/utils';

interface DevLogsPanelProps {
  output: string;
  className?: string;
  emptyMessage?: string;
}

export function DevLogsPanel({
  output,
  className,
  emptyMessage = 'Waiting for dev server output…',
}: DevLogsPanelProps) {
  const followOutputRef = useFollowOutput();

  return (
    <div className={cn('h-full bg-background', className)}>
      {/* Output - no header, connection status is shown in the tab bar */}
      <div
        ref={followOutputRef}
        className="h-full overflow-y-auto overflow-x-auto scroll-smooth font-mono text-xs p-4 bg-black text-white"
      >
        <pre className="whitespace-pre-wrap break-words">{output || emptyMessage}</pre>
      </div>
    </div>
  );
}
