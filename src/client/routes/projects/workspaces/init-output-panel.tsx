import { useEffect, useRef } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';

interface InitOutputPanelProps {
  output: string | null;
  className: string;
  emptyMessage?: string;
}

export function InitOutputPanel({
  output,
  className,
  emptyMessage = 'Waiting for output...',
}: InitOutputPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current && output !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [output]);

  return (
    <ScrollArea viewportRef={scrollRef} className={className}>
      <pre className="p-2 text-xs font-mono text-zinc-300 whitespace-pre-wrap break-words">
        {output || <span className="text-zinc-500 italic">{emptyMessage}</span>}
      </pre>
    </ScrollArea>
  );
}
