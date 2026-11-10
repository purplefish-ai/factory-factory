import { useFollowOutput } from '@/client/hooks/use-follow-output';
import { ScrollArea } from '@/components/ui/scroll-area';

interface InitOutputPanelProps {
  output: string | null;
  className: string;
  emptyMessage?: string;
}

export function InitOutputPanel({
  output,
  className,
  emptyMessage = 'Waiting for output…',
}: InitOutputPanelProps) {
  const followOutputRef = useFollowOutput();

  return (
    <ScrollArea viewportRef={followOutputRef} className={className}>
      <pre className="p-2 text-xs font-mono text-foreground whitespace-pre-wrap break-words">
        {output || <span className="text-foreground italic">{emptyMessage}</span>}
      </pre>
    </ScrollArea>
  );
}
