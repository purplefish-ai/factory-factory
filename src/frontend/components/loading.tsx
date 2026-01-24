import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface LoadingProps {
  message?: string;
  className?: string;
}

export function Loading({ message = 'Loading...', className }: LoadingProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 h-full min-h-[200px]',
        className
      )}
    >
      <Spinner className="size-6" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
